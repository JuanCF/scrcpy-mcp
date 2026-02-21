import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdbShell, resolveSerial, getDeviceProperty } from "../utils/adb.js"
import {
  hasActiveSession,
  getClipboardViaScrcpy,
  setClipboardViaScrcpy,
} from "../utils/scrcpy.js"

async function getClipboardViaAdb(serial: string): Promise<string | null> {
  try {
    const sdkStr = await getDeviceProperty(serial, "ro.build.version.sdk")
    const sdkLevel = parseInt(sdkStr, 10)

    if (!isNaN(sdkLevel) && sdkLevel >= 31) {
      const result = await execAdbShell(serial, "cmd clipboard get")
      if (result && !result.includes("not found") && !result.includes("Error")) {
        return result.trim()
      }
    }

    const serviceResult = await execAdbShell(serial, "service call clipboard 2")
    if (serviceResult) {
      // Try multiple parsing strategies for clipboard service output
      let text: string | null = null

      // Strategy 1: Original pattern - result=0...) followed by content
      let match = serviceResult.match(/result=0[^)]*\)\s*(.+)/i)
      if (match && match[1]) {
        text = match[1].trim()
      }

      // Strategy 2: Look for quoted strings (common in service dumps)
      if (!text) {
        match = serviceResult.match(/"([^"]*)"/)
        if (match && match[1]) {
          text = match[1]
        }
      }

      // Strategy 3: Look for hex string patterns (e.g., 0x1234 or hex array)
      if (!text) {
        match = serviceResult.match(/0x([0-9a-fA-F]+)/)
        if (match && match[1]) {
          try {
            const hex = match[1]
            text = Buffer.from(hex, "hex").toString("utf8")
          } catch {
            // Fall through to null
          }
        }
      }

      if (text) {
        // Normalize escape sequences (octal \ddd -> char)
        text = text.replace(/\\(\d{3})/g, (_, oct) =>
          String.fromCharCode(parseInt(oct, 8))
        )
        return text
      }

      console.error(`[clipboard_get] Could not parse service result: ${serviceResult}`)
    }

    return null
  } catch {
    return null
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
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)

        if (hasActiveSession(s)) {
          try {
            const content = await getClipboardViaScrcpy(s)
            if (content !== null) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({ content, source: "scrcpy" }),
                }],
              }
            }
            console.error("[clipboard_get] scrcpy returned null, trying ADB fallback")
          } catch (error) {
            const err = error as Error
            console.error(`[clipboard_get] scrcpy failed, falling back to ADB: ${err.message}`)
          }
        }

        const content = await getClipboardViaAdb(s)
        if (content !== null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ content, source: "adb" }),
            }],
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: true,
              message: "Could not retrieve clipboard content. On Android 10+, start a scrcpy session for reliable clipboard access.",
            }),
          }],
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: true, message: err.message }),
          }],
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
    },
    async ({ text, paste, serial }) => {
      try {
        const s = await resolveSerial(serial)

        if (hasActiveSession(s)) {
          try {
            await setClipboardViaScrcpy(s, text, paste)
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: paste
                    ? `Clipboard set and paste triggered: "${text}"`
                    : `Clipboard set: "${text}"`,
                  source: "scrcpy",
                }),
              }],
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
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Clipboard set: "${text}".${pasteNote}`,
                source: "adb",
              }),
            }],
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
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: true, message: err.message }),
          }],
        }
      }
    }
  )
}
