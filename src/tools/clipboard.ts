import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdb, execAdbShell, resolveSerial, getDeviceProperty } from "../utils/adb.js"
import {
  hasActiveSession,
  getClipboardViaScrcpy,
  setClipboardViaScrcpy,
} from "../utils/scrcpy.js"

/**
 * Extract the payload bytes of a `service call` parcel dump.
 *
 * Each line interleaves an address label, four little-endian words and an
 * ASCII gutter:
 *
 *   0x00000000: fffffffd 00000008 006f004e 00690020 '........N.o. .i.'
 *
 * Only the middle columns are payload. The old hex strategy ran a bare
 * /0x([0-9a-f]+)/ over the whole dump, matched the *address label* on the
 * first line, and decoded 0x00000000 into four NUL bytes — so a clipboard the
 * device refused to hand over was reported as the content "\0\0\0\0".
 */
export function parseServiceCallParcel(output: string): Buffer | null {
  const words: number[] = []

  for (const line of output.split("\n")) {
    const match = line.match(/^\s*0x[0-9a-f]{8}:\s*((?:[0-9a-f]{8}(?:\s+|$))+)/i)
    if (!match) continue
    for (const word of match[1].trim().split(/\s+/)) {
      words.push(parseInt(word, 16))
    }
  }

  if (words.length === 0) return null

  // The dump prints each word big-endian, but the bytes sit in memory
  // little-endian: 006f004e with gutter 'N.o.' is 4e 00 6f 00, UTF-16LE "No".
  const buf = Buffer.alloc(words.length * 4)
  words.forEach((word, i) => buf.writeUInt32LE(word >>> 0, i * 4))
  return buf
}

export interface ParcelException {
  code: number
  /** The UTF-16LE message following the status word, when the parcel carries one. */
  message: string | null
}

/**
 * Read the exception a parcel carries, or null when it holds a normal reply.
 *
 * A Binder reply parcel opens with a status word: 0 means success, anything
 * else is an exception followed by a UTF-16LE message. The clipboard service
 * answers a shell-UID read with -3 / "No items", because since Android 10 only
 * the foreground app or default IME may read the clipboard.
 */
export function parcelException(parcel: Buffer): ParcelException | null {
  if (parcel.length < 4) return null

  const code = parcel.readInt32LE(0)
  if (code === 0) return null

  if (parcel.length >= 8) {
    const length = parcel.readInt32LE(4)
    if (length > 0 && 8 + length * 2 <= parcel.length) {
      return { code, message: parcel.subarray(8, 8 + length * 2).toString("utf16le") }
    }
  }
  return { code, message: null }
}

export function formatParcelException({ code, message }: ParcelException): string {
  return message ? `${message} (code ${code})` : `code ${code}`
}

/** Machine-readable reason attached to a clipboard_get error the service refused. */
export const CLIPBOARD_READ_REFUSED = "clipboard_read_refused"

interface AdbClipboardRead {
  content: string | null
  /** Set when the clipboard service itself refused the read. */
  refusal?: ParcelException
}

async function getClipboardViaAdb(serial: string): Promise<AdbClipboardRead> {
  try {
    const sdkStr = await getDeviceProperty(serial, "ro.build.version.sdk")
    const sdkLevel = parseInt(sdkStr, 10)

    if (!isNaN(sdkLevel) && sdkLevel >= 31) {
      // Not execAdbShell: a device without this shell command prints
      // "No shell command implementation." to *stderr* and still exits 0, so
      // reading stdout alone yields "" and silently falls through to the
      // parcel path. Check stderr so the unsupported case is visible.
      const { stdout, stderr } = await execAdb(["-s", serial, "shell", "cmd clipboard get"])
      const result = stdout.trim()
      const failed = stderr.trim().length > 0
      if (failed) {
        console.error(`[clipboard_get] cmd clipboard get unavailable: ${stderr.trim()}`)
      } else if (result && !result.includes("not found") && !result.includes("Error")) {
        return { content: result }
      }
    }

    const serviceResult = await execAdbShell(serial, "service call clipboard 2")
    if (serviceResult) {
      // An exception parcel carries no content at all; reporting the refusal
      // lets the tool return a real error instead of inventing a clipboard
      // value, and lets callers tell a refusal from a transport failure.
      const parcel = parseServiceCallParcel(serviceResult)
      if (parcel) {
        const refusal = parcelException(parcel)
        if (refusal) {
          console.error(
            `[clipboard_get] clipboard service refused the read: ${formatParcelException(refusal)}`
          )
          return { content: null, refusal }
        }
      }

      // Legacy text shapes, for builds whose clipboard service answers in
      // plain text rather than a parcel dump.
      let text: string | null = null

      // Strategy 1: Original pattern - result=0...) followed by content
      let match = serviceResult.match(/result=0[^)]*\)\s*(.+)/i)
      if (match && match[1]) {
        text = match[1].trim()
      }

      // Strategy 2: Look for quoted strings (common in service dumps)
      if (!text) {
        match = serviceResult.match(/"([^"]*)"/)
        if (match && match[1] !== undefined) {
          text = match[1]
        }
      }

      // An empty clipboard is content, not a failure — hence !== null.
      if (text !== null) {
        // Normalize escape sequences (octal \ddd -> char)
        text = text.replace(/\\(\d{3})/g, (_, oct) =>
          String.fromCharCode(parseInt(oct, 8))
        )
        return { content: text }
      }

      if (parcel) {
        // A permitted read answers transaction 2 with IClipboard.getPrimaryClip's
        // return value: a *nullable ClipData*, not a bare string. The reply is a
        // presence marker followed by a ClipDescription (label, MIME array,
        // PersistableBundle, timestamp, flags that differ per platform version)
        // and only then the items, so the text cannot be lifted off a fixed
        // offset — decoding the marker as a string length yields garbage.
        // `cmd clipboard get` and the scrcpy control path cover this case.
        console.error(
          "[clipboard_get] clipboard service returned a ClipData parcel, which is not decoded here; use a scrcpy session"
        )
      } else {
        console.error(`[clipboard_get] Could not parse service result: ${serviceResult}`)
      }
    }

    return { content: null }
  } catch {
    return { content: null }
  }
}

async function setClipboardViaAdb(serial: string, text: string): Promise<boolean> {
  try {
    const sdkStr = await getDeviceProperty(serial, "ro.build.version.sdk")
    const sdkLevel = parseInt(sdkStr, 10)

    // Encode text as base64 to avoid shell injection issues
    const base64Text = Buffer.from(text).toString("base64")

    if (!isNaN(sdkLevel) && sdkLevel >= 29) {
      // Decode base64 and pipe to clipboard command - avoids shell interpolation
      await execAdbShell(serial, `echo "${base64Text}" | base64 -d | cmd clipboard set`)
      return true
    }

    // Fallback to broadcast for older Android versions
    await execAdbShell(
      serial,
      `echo "${base64Text}" | base64 -d | xargs -0 am broadcast -a clipper.set -e text`
    )
    return true
  } catch {
    return false
  }
}

export function registerClipboardTools(server: McpServer): void {
  server.registerTool(
    "clipboard_get",
    {
      description: "Get the current clipboard content from the device. Uses scrcpy GET_CLIPBOARD when a session is active (works on Android 10+), falls back to ADB clipboard commands.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        content: z.string().describe("Current clipboard text on the device"),
        source: z.string().describe("Mechanism used to read the clipboard (scrcpy or adb)"),
      },
      annotations: {
        title: "Get Clipboard",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)

        if (hasActiveSession(s)) {
          try {
            const content = await getClipboardViaScrcpy(s)
            if (content !== null) {
              return {
                content: [{ type: "text", text: JSON.stringify({ content, source: "scrcpy" }) }],
                structuredContent: { content, source: "scrcpy" },
              }
            }
            console.error("[clipboard_get] scrcpy returned null, trying ADB fallback")
          } catch (error) {
            const err = error as Error
            console.error(`[clipboard_get] scrcpy failed, falling back to ADB: ${err.message}`)
          }
        }

        const adb = await getClipboardViaAdb(s)
        if (adb.content !== null) {
          const structured = { content: adb.content, source: "adb" }
          return {
            content: [{ type: "text", text: JSON.stringify(structured) }],
            structuredContent: structured,
          }
        }

        // A refusal by the clipboard service is a permanent property of the
        // device, not a transport failure, so it carries its own reason and
        // Binder code — callers (and the integration suite) can tell the two
        // apart instead of treating every error the same.
        const failure = adb.refusal
          ? {
            error: true,
            reason: CLIPBOARD_READ_REFUSED,
            code: adb.refusal.code,
            message: `The device clipboard service refused the read: ${formatParcelException(adb.refusal)}. Since Android 10 the clipboard is readable only by the foreground app or the default IME, and some vendor builds refuse it even over scrcpy.`,
          }
          : {
            error: true,
            message: "Could not retrieve clipboard content. On Android 10+ the clipboard is readable only by the foreground app or the default IME; start a scrcpy session, and note that some vendor builds refuse the read entirely.",
          }

        return {
          content: [{ type: "text", text: JSON.stringify(failure) }],
          isError: true as const,
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: true, message: err.message }),
          }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    "clipboard_set",
    {
      description: "Set the clipboard content on the device. Uses scrcpy SET_CLIPBOARD when a session is active (with optional paste flag), falls back to ADB clipboard commands.",
      inputSchema: {
        text: z.string().describe("Text to set in the clipboard"),
        paste: z.boolean().optional().default(false).describe("Also simulate paste action (scrcpy only)"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the clipboard was set"),
        message: z.string().describe("Human-readable description of the result"),
        source: z.string().optional().describe("Mechanism used to set the clipboard (scrcpy or adb)"),
      },
      annotations: {
        title: "Set Clipboard",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ text, paste, serial }) => {
      try {
        const s = await resolveSerial(serial)

        if (hasActiveSession(s)) {
          try {
            await setClipboardViaScrcpy(s, text, paste)
            const structured = {
              success: true,
              message: paste
                ? `Clipboard set and paste triggered: "${text}"`
                : `Clipboard set: "${text}"`,
              source: "scrcpy",
            }
            return {
              content: [{ type: "text", text: JSON.stringify(structured) }],
              structuredContent: structured,
            }
          } catch (error) {
            const err = error as Error
            console.error(`[clipboard_set] scrcpy failed, falling back to ADB: ${err.message}`)
          }
        }

        const success = await setClipboardViaAdb(s, text)
        if (success) {
          const pasteNote = paste
            ? " Note: Paste action not performed (requires active scrcpy session)."
            : ""
          const structured = {
            success: true,
            message: `Clipboard set: "${text}".${pasteNote}`,
            source: "adb",
          }
          return {
            content: [{ type: "text", text: JSON.stringify(structured) }],
            structuredContent: structured,
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: true,
              message: "Could not set clipboard content. On Android 10+, start a scrcpy session for reliable clipboard access.",
            }),
          }],
          isError: true as const,
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: true, message: err.message }),
          }],
          isError: true as const,
        }
      }
    }
  )
}
