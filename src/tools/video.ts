import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { resolveSerial } from "../utils/adb.js"
import { hasActiveSession, getSession, startSession } from "../utils/scrcpy.js"
import { startMjpegServer, startStreamViewer, stopMjpegServer, isMjpegServerRunning } from "../utils/mjpeg.js"

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "start_video_stream",
    {
      description: "Start an HTTP MJPEG video stream of the device screen and open a viewer window (ffplay). Starts a scrcpy session automatically if needed.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        port: z.number().int().min(1024).max(65535).optional().default(7183).describe("HTTP port for the MJPEG stream (default 7183)"),
      },
      outputSchema: {
        status: z.string().describe("Stream status (e.g. 'started')"),
        url: z.string().describe("HTTP URL of the MJPEG stream"),
        screenSize: z.object({
          width: z.number().int().describe("Native display width"),
          height: z.number().int().describe("Native display height"),
        }).describe("Native display resolution — tap/swipe use these native coordinates (no scaling)"),
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
        let session = getSession(s)
        if (!session || !hasActiveSession(s)) {
          session = await startSession(s)
        }
        const url = await startMjpegServer(s, port)

        const viewerLaunched = await startStreamViewer(s, url)

        const structured = {
          status: "started",
          url,
          screenSize: session.screenSize,
          viewer: viewerLaunched ? "ffplay window opened" : "ffplay not available — open the stream URL manually",
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
