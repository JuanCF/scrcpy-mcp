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
      const match = serviceResult.match(/result=0[^)]*\)\s*(.+)/i)
      if (match && match[1]) {
        let text = match[1].trim()
        text = text.replace(/\\(\d{3})/g, (_, oct) =>
          String.fromCharCode(parseInt(oct, 8))
        )
        return text
      }
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

    const escaped = text.replace(/"/g, '\\"').replace(/'/g, "\\'")

    if (!isNaN(sdkLevel) && sdkLevel >= 29) {
      await execAdbShell(serial, `cmd clipboard set "${escaped}"`)
      return true
    }

    await execAdbShell(
      serial,
      `am broadcast -a clipper.set -e text "${escaped}"`
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
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Clipboard set: "${text}"`,
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
