import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execAdb, execAdbRaw, resolveSerial } from "../utils/adb.js";
import { spawn, ChildProcess } from "child_process";

interface RecordingSession {
  proc: ChildProcess;
  remotePath: string;
}

const recordingSessions: Map<string, RecordingSession> = new Map();

export function registerVisionTools(server: McpServer) {
  server.tool(
    "screenshot",
    "Take a screenshot of the Android device screen. Returns the image as base64.",
    {
      serial: z.string().optional().describe("Device serial number"),
    },
    async ({ serial }) => {
      const s = await resolveSerial(serial);
      const pngBuffer = await execAdbRaw(["-s", s, "exec-out", "screencap", "-p"]);
      
      return {
        content: [
          {
            type: "image" as const,
            data: pngBuffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    }
  );

  server.tool(
    "screen_record_start",
    "Start recording the screen. Recording continues until screen_record_stop is called.",
    {
      serial: z.string().optional().describe("Device serial number"),
      remotePath: z
        .string()
        .optional()
        .default("/sdcard/scrcpy-mcp-recording.mp4")
        .describe("Path on device to save recording"),
      duration: z
        .number()
        .optional()
        .describe("Max recording duration in seconds (optional, device limit usually 180s)"),
    },
    async ({ serial, remotePath, duration }) => {
      const s = await resolveSerial(serial);
      
      if (recordingSessions.has(s)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Recording already in progress for device ${s}`,
            },
          ],
        };
      }

      const args = ["-s", s, "shell", "screenrecord", remotePath];
      if (duration) {
        args.push("--time-limit", String(duration));
      }

      const proc = spawn("adb", args);
      recordingSessions.set(s, { proc, remotePath });

      proc.on("close", () => {
        recordingSessions.delete(s);
      });

      proc.stderr?.on("data", (data) => {
        console.error(`[screenrecord ${s}] ${data}`);
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Recording started on device ${s}. Will save to ${remotePath}`,
          },
        ],
      };
    }
  );

  server.tool(
    "screen_record_stop",
    "Stop screen recording and optionally pull the file to the host.",
    {
      serial: z.string().optional().describe("Device serial number"),
      pullToHost: z
        .boolean()
        .optional()
        .default(false)
        .describe("Pull the recording to the host machine"),
      localPath: z
        .string()
        .optional()
        .describe("Local path to save recording (only if pullToHost is true)"),
    },
    async ({ serial, pullToHost, localPath }) => {
      const s = await resolveSerial(serial);
      
      const session = recordingSessions.get(s);
      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No recording in progress for device ${s}`,
            },
          ],
        };
      }

      const { proc, remotePath } = session;
      proc.kill("SIGINT");
      recordingSessions.delete(s);

      await new Promise((resolve) => setTimeout(resolve, 500));

      if (pullToHost) {
        const targetPath = localPath || `./recording-${s}.mp4`;
        await execAdb(["-s", s, "pull", remotePath, targetPath]);
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Recording stopped and saved to ${targetPath}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Recording stopped. File saved on device at ${remotePath}`,
          },
        ],
      };
    }
  );
}
