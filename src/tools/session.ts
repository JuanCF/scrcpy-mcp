import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { resolveSerial } from "../utils/adb.js"
import { startSession, stopSession } from "../utils/scrcpy.js"
import { stopMjpegServer } from "../utils/mjpeg.js"

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
      outputSchema: {
        status: z.string().describe("Session status (e.g. 'connected')"),
        serial: z.string().describe("Resolved device serial"),
        screenSize: z.object({
          width: z.number().int().describe("scrcpy video frame width"),
          height: z.number().int().describe("scrcpy video frame height"),
        }).describe("scrcpy video frame size — use these coordinates for tap/swipe"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: {
        title: "Start scrcpy Session",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ serial, maxSize, maxFps }) => {
      try {
        const s = await resolveSerial(serial)
        const session = await startSession(s, { maxSize, maxFps })
        const structured = {
          status: "connected",
          serial: s,
          screenSize: session.screenSize,
          message: "scrcpy session active. Input and screenshots will use the fast path.",
        }
        return {
          content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
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
          isError: true as const,
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
      outputSchema: {
        success: z.boolean().describe("Whether the session was stopped"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: {
        title: "Stop scrcpy Session",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)
        await stopSession(s)
        stopMjpegServer(s)
        const message = "scrcpy session stopped. Tools will use ADB fallback."
        return {
          content: [{ type: "text", text: message }],
          structuredContent: { success: true, message },
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
          isError: true as const,
        }
      }
    }
  )
}
