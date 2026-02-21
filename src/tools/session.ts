import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { resolveSerial } from "../utils/adb.js"
import { startSession, stopSession } from "../utils/scrcpy.js"

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    "start_session",
    {
      description: "Start a scrcpy session for fast input control and screenshots. When a session is active, tap/swipe/text/screenshot are 10-50x faster. Requires scrcpy-server to be installed.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        maxSize: z.number().int().positive().optional().default(1024).describe("Max screen dimension in pixels (default 1024)"),
        maxFps: z.number().int().positive().optional().default(30).describe("Max frames per second (default 30)"),
      },
    },
    async ({ serial, maxSize, maxFps }) => {
      try {
        const s = await resolveSerial(serial)
        const session = await startSession(s, { maxSize, maxFps })
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "connected",
              serial: s,
              screenSize: session.screenSize,
              message: "scrcpy session active. Input and screenshots will use the fast path.",
            }, null, 2),
          }],
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: `Failed to start scrcpy session: ${err.message}`,
            }, null, 2),
          }],
        }
      }
    }
  )

  server.registerTool(
    "stop_session",
    {
      description: "Stop the active scrcpy session. Tools will fall back to ADB commands.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)
        await stopSession(s)
        return {
          content: [{
            type: "text",
            text: "scrcpy session stopped. Tools will use ADB fallback.",
          }],
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: true,
              message: `Failed to stop scrcpy session: ${err.message}`,
            }),
          }],
        }
      }
    }
  )
}
