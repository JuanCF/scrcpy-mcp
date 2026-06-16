import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdbShell, resolveSerial } from "../utils/adb.js"

export function registerShellTools(server: McpServer): void {
  server.registerTool(
    "shell_exec",
    {
      description:
        "Execute an arbitrary ADB shell command on the device and return the output. " +
        "Use this for any device operation not covered by other tools.",
      inputSchema: {
        command: z.string().describe("Shell command to execute on the device"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        output: z.string().describe("Combined stdout/stderr text from the command"),
      },
      annotations: {
        title: "ADB Shell Command",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, serial }) => {
      try {
        const s = await resolveSerial(serial)
        const output = await execAdbShell(s, command)
        return {
          content: [{ type: "text", text: output }],
          structuredContent: { output },
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
