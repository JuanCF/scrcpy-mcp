import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdbShell, resolveSerial } from "../utils/adb.js"
import { hasActiveSession, startAppViaScrcpy } from "../utils/scrcpy.js"

export function registerAppTools(server: McpServer): void {
  server.registerTool(
    "app_start",
    {
      description: "Launch an app on the device. Uses scrcpy START_APP when a session is active for faster launch, falls back to ADB `am start`. Supports force-stop prefix (+) to stop the app before launching.",
      inputSchema: {
        packageName: z.string().describe("Package name to launch (e.g., 'com.example.app'). Prefix with '+' to force-stop the app first (e.g., '+com.example.app')"),
        serial: z.string().optional().describe("Device serial number"),
      },
    },
    async ({ packageName, serial }) => {
      try {
        const s = await resolveSerial(serial)

        // Check if force-stop is requested (starts with +)
        const forceStop = packageName.startsWith("+")
        const actualPackageName = forceStop ? packageName.slice(1) : packageName

        if (!actualPackageName) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: true, message: "Package name is required" }),
            }],
          }
        }

        // Use scrcpy fast path if session is active
        if (hasActiveSession(s)) {
          // If force-stop requested, do it first via ADB (scrcpy doesn't have force-stop)
          if (forceStop) {
            try {
              await execAdbShell(s, `am force-stop ${actualPackageName}`)
              console.error(`[app_start] Force-stopped ${actualPackageName}`)
            } catch {
              // Ignore force-stop errors (app may not be running)
            }
          }

          try {
            await startAppViaScrcpy(s, actualPackageName)
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: forceStop
                    ? `App force-stopped and started: ${actualPackageName}`
                    : `App started: ${actualPackageName}`,
                  source: "scrcpy",
                }),
              }],
            }
          } catch (error) {
            const err = error as Error
            console.error(`[app_start] scrcpy failed, falling back to ADB: ${err.message}`)
          }
        }

        // ADB fallback
        // If force-stop is requested, run that first
        if (forceStop) {
          try {
            await execAdbShell(s, `am force-stop ${actualPackageName}`)
            console.error(`[app_start] Force-stopped ${actualPackageName}`)
          } catch {
            // Ignore force-stop errors (app may not be running)
          }
        }

        // Launch the app via ADB using monkey to resolve the correct launcher activity
        await execAdbShell(s, `monkey -p ${actualPackageName} -c android.intent.category.LAUNCHER 1`)

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: forceStop
                ? `App force-stopped and started: ${actualPackageName}`
                : `App started: ${actualPackageName}`,
              source: "adb",
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
