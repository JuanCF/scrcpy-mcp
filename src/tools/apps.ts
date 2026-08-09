import * as path from "path"
import * as fs from "fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdb, execAdbShell, resolveSerial } from "../utils/adb.js"
import { hasActiveSession, startAppViaScrcpy } from "../utils/scrcpy.js"

export function isValidPackageName(name: string): boolean {
  return /^(?:[A-Za-z][A-Za-z0-9_]*)(?:\.(?:[A-Za-z][A-Za-z0-9_]*))+$/.test(name)
}

export function isUninstallSuccess(output: string): boolean {
  return !output.startsWith("Failure") && !output.includes("DELETE_FAILED")
}

// Return a successful result whose structured content mirrors the serialized JSON text.
function dataOk<T extends Record<string, unknown>>(structuredContent: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: true, message }) }],
    isError: true as const,
  }
}

export function registerAppTools(server: McpServer): void {
  server.registerTool(
    "app_start",
    {
      description: "Launch an app on the device. Uses scrcpy START_APP when a session is active for faster launch, falls back to ADB `am start`. Supports force-stop prefix (+) to stop the app before launching.",
      inputSchema: {
        packageName: z.string().describe("Package name to launch (e.g., 'com.example.app'). Prefix with '+' to force-stop the app first (e.g., '+com.example.app')"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the app was launched"),
        message: z.string().describe("Human-readable description of the result"),
        source: z.string().optional().describe("Mechanism used to launch the app (scrcpy or adb)"),
      },
      annotations: {
        title: "Launch App",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ packageName, serial }) => {
      try {
        const s = await resolveSerial(serial)

        // Check if force-stop is requested (starts with +)
        const forceStop = packageName.startsWith("+")
        const actualPackageName = forceStop ? packageName.slice(1) : packageName

        if (!actualPackageName) {
          return toolError("Package name is required")
        }

        if (!isValidPackageName(actualPackageName)) {
          return toolError(`Invalid package name: ${actualPackageName}`)
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
            return dataOk({
              success: true,
              message: forceStop
                ? `App force-stopped and started: ${actualPackageName}`
                : `App started: ${actualPackageName}`,
              source: "scrcpy",
            })
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

        return dataOk({
          success: true,
          message: forceStop
            ? `App force-stopped and started: ${actualPackageName}`
            : `App started: ${actualPackageName}`,
          source: "adb",
        })
      } catch (error) {
        const err = error as Error
        return toolError(err.message)
      }
    }
  )

  server.registerTool(
    "app_stop",
    {
      description: "Force-stop an app on the device.",
      inputSchema: {
        packageName: z.string().describe("Package name to force-stop (e.g., 'com.example.app')"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the app was force-stopped"),
        message: z.string().describe("Human-readable description of the result"),
      },
      annotations: {
        title: "Force-Stop App",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ packageName, serial }) => {
      try {
        const s = await resolveSerial(serial)
        if (!isValidPackageName(packageName)) {
          return toolError(`Invalid package name: ${packageName}`)
        }
        await execAdbShell(s, `am force-stop ${packageName}`)
        return dataOk({ success: true, message: `App stopped: ${packageName}` })
      } catch (error) {
        const err = error as Error
        return toolError(err.message)
      }
    }
  )

  server.registerTool(
    "app_install",
    {
      description: "Install an APK file on the device from the host machine.",
      inputSchema: {
        apkPath: z.string().describe("Absolute path to the APK file on the host machine"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the APK installed successfully"),
        message: z.string().describe("Install result or error output from adb"),
      },
      annotations: {
        title: "Install APK",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ apkPath, serial }) => {
      try {
        if (path.extname(apkPath).toLowerCase() !== ".apk") {
          return toolError("Invalid apkPath: invalid extension, must be a .apk file")
        }
        if (!path.isAbsolute(apkPath)) {
          return toolError("Invalid apkPath: must be an absolute path")
        }
        if (!fs.existsSync(apkPath)) {
          return toolError("Invalid apkPath: file does not exist")
        }
        const s = await resolveSerial(serial)
        const { stdout, stderr } = await execAdb(["-s", s, "install", "-r", apkPath])
        const output = (stdout + stderr).trim()
        const success = output.includes("Success")
        return dataOk({
          success,
          message: success ? `APK installed: ${apkPath}` : output,
        })
      } catch (error) {
        const err = error as Error
        return toolError(err.message)
      }
    }
  )

  server.registerTool(
    "app_uninstall",
    {
      description: "Uninstall an app from the device.",
      inputSchema: {
        packageName: z.string().describe("Package name to uninstall (e.g., 'com.example.app')"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the app was uninstalled"),
        message: z.string().describe("Uninstall result or error output from adb"),
      },
      annotations: {
        title: "Uninstall App",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ packageName, serial }) => {
      try {
        if (!isValidPackageName(packageName)) {
          return toolError(`Invalid package name: ${packageName}`)
        }
        const s = await resolveSerial(serial)
        const { stdout, stderr } = await execAdb(["-s", s, "uninstall", packageName])
        const output = (stdout + stderr).trim()
        const success = isUninstallSuccess(output)
        return dataOk({
          success,
          message: success ? (output || `App uninstalled: ${packageName}`) : output,
        })
      } catch (error) {
        const err = error as Error
        return toolError(err.message)
      }
    }
  )

  server.registerTool(
    "app_list",
    {
      description: "List installed packages on the device. Optionally filter by name or restrict to system/third-party apps.",
      inputSchema: {
        filter: z.string().optional().describe("Filter packages by name (partial match, case-insensitive)"),
        system: z.boolean().optional().describe("true = system apps only, false = third-party only, omit = all"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        count: z.number().int().describe("Number of packages returned"),
        packages: z.array(z.string()).describe("Installed package names"),
      },
      annotations: {
        title: "List Installed Apps",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ filter, system, serial }) => {
      try {
        const s = await resolveSerial(serial)
        const args = ["pm", "list", "packages"]
        if (system === true) {
          args.push("-s")
        } else if (system === false) {
          args.push("-3")
        }
        const output = await execAdbShell(s, args.join(" "))
        let packages = output
          .split("\n")
          .map((line) => line.replace(/^package:/, "").trim())
          .filter(Boolean)
        if (filter) {
          const lowerFilter = filter.toLowerCase()
          packages = packages.filter((p) => p.toLowerCase().includes(lowerFilter))
        }
        return dataOk({ count: packages.length, packages })
      } catch (error) {
        const err = error as Error
        return toolError(err.message)
      }
    }
  )

  server.registerTool(
    "app_current",
    {
      description: "Get the currently foregrounded app package name and activity.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        packageName: z.string().describe("Package name of the foreground app"),
        activity: z.string().nullable().describe("Foreground activity name, if resolvable"),
      },
      annotations: {
        title: "Current Foreground App",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)
        const output = await execAdbShell(s, "dumpsys activity activities")
        // Format: mResumedActivity: ActivityRecord{xxxx u0 com.pkg/.Activity t1}
        const match = output.match(
          /m?ResumedActivity\s*[:=]\s*ActivityRecord\{[^}]+\s+u\d+\s+([^\s/}]+)(\/[^\s}]+)?/i
        )
        if (!match) {
          return toolError("Could not determine current activity")
        }
        const packageName = match[1]
        const activity = match[2] ? match[2].replace(/^\/+/, "") : null
        return dataOk({ packageName, activity })
      } catch (error) {
        const err = error as Error
        return toolError(err.message)
      }
    }
  )
}
