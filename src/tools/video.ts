import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { resolveSerial } from "../utils/adb.js"
import { hasActiveSession, getSession } from "../utils/scrcpy.js"
import { startMjpegServer, startMjpegViewer, stopMjpegServer, isMjpegServerRunning } from "../utils/mjpeg.js"

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "start_video_stream",
    {
      description: "Start an HTTP MJPEG video stream of the device screen. Opens a native ffplay window that connects to the stream URL. Requires an active scrcpy session.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        port: z.number().int().min(1024).max(65535).optional().default(7183).describe("HTTP port for the MJPEG stream (default 7183)"),
      },
      outputSchema: {
        status: z.string().describe("Stream status (e.g. 'started')"),
        url: z.string().describe("HTTP URL of the MJPEG stream"),
        screenSize: z.object({
          width: z.number().int().describe("scrcpy video frame width"),
          height: z.number().int().describe("scrcpy video frame height"),
        }).describe("scrcpy video frame size"),
        viewer: z.string().describe("Viewer status message"),
      },
      annotations: {
        title: "Start Video Stream",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ serial, port }) => {
      try {
        const s = await resolveSerial(serial)
        if (!hasActiveSession(s)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "error",
                message: "No active scrcpy session. Call start_session first.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        const session = getSession(s)
        if (!session) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "error",
                message: "No active scrcpy session. Call start_session first.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        const resolvedPort = port
        const url = await startMjpegServer(s, resolvedPort)

        const viewerLaunched = await startMjpegViewer(
          s, session.screenSize.width, session.screenSize.height, resolvedPort
        )

        const structured = {
          status: "started",
          url,
          screenSize: session.screenSize,
          viewer: viewerLaunched ? "ffplay window opened" : "ffplay not available — open URL manually",
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
              message: `Failed to start video stream: ${err.message}`,
            }, null, 2),
          }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    "stop_video_stream",
    {
      description: "Stop the HTTP MJPEG video stream and close the viewer window for a device.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        status: z.string().describe("Stream status (e.g. 'stopped')"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: {
        title: "Stop Video Stream",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)
        if (!isMjpegServerRunning(s)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "error",
                message: "No video stream is running for this device.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        stopMjpegServer(s)
        const structured = { status: "stopped", message: "Video stream stopped." }
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
              message: `Failed to stop video stream: ${err.message}`,
            }, null, 2),
          }],
          isError: true as const,
        }
      }
    }
  )
}
