import * as nodePath from "path"
import * as fs from "fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdb, execAdbShell, resolveSerial } from "../utils/adb.js"

export interface FileEntry {
  name: string
  permissions: string
  owner: string
  group: string
  size: number
  date: string
  isDirectory: boolean
}

export function parseLsOutput(output: string): FileEntry[] {
  const entries: FileEntry[] = []
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("total ")) continue

    // Matches: permissions links owner group size YYYY-MM-DD HH:MM name
    // Handles optional SELinux suffix (. or +) on permissions field
    const match = trimmed.match(
      /^([dlbcsp-][rwxst-]{9}[+.]?)\s+\d+\s+(\S+)\s+(\S+)\s+(\d+(?:,\s*\d+)?)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/
    )
    if (!match) continue

    const [, permissions, owner, group, sizeStr, date, namePart] = match
    // Strip symlink target (e.g. "link -> /path/to/target")
    const name = namePart.split(" -> ")[0].trim()

    entries.push({
      name,
      permissions,
      owner,
      group,
      size: sizeStr.includes(",") ? 0 : parseInt(sizeStr, 10),
      date,
      isDirectory: permissions.startsWith("d"),
    })
  }
  return entries
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    "file_push",
    {
      description: "Push a file from the host machine to the device.",
      inputSchema: {
        localPath: z.string().describe("Absolute path to the file on the host machine"),
        remotePath: z.string().describe("Destination path on the device (e.g., /sdcard/myfile.txt)"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the file was pushed"),
        message: z.string().describe("adb push result or a confirmation message"),
      },
      annotations: {
        title: "Push File to Device",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ localPath, remotePath, serial }) => {
      try {
        if (!nodePath.isAbsolute(localPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: true, message: "localPath must be an absolute path" }),
            }],
            isError: true as const,
          }
        }
        if (!fs.existsSync(localPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: true, message: `File not found: ${localPath}` }),
            }],
            isError: true as const,
          }
        }
        const s = await resolveSerial(serial)
        const { stdout, stderr } = await execAdb(["-s", s, "push", localPath, remotePath])
        const output = (stdout + stderr).trim()
        const message = output || `Pushed ${localPath} to ${remotePath}`
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message }) }],
          structuredContent: { success: true, message },
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

  server.registerTool(
    "file_pull",
    {
      description: "Pull a file from the device to the host machine.",
      inputSchema: {
        remotePath: z.string().describe("Path to the file on the device (e.g., /sdcard/myfile.txt)"),
        localPath: z.string().describe("Destination absolute path on the host machine"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the file was pulled"),
        message: z.string().describe("adb pull result or a confirmation message"),
      },
      annotations: {
        title: "Pull File from Device",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ remotePath, localPath, serial }) => {
      try {
        if (!nodePath.isAbsolute(localPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: true, message: "localPath must be an absolute path" }),
            }],
            isError: true as const,
          }
        }
        const s = await resolveSerial(serial)
        const { stdout, stderr } = await execAdb(["-s", s, "pull", remotePath, localPath])
        const output = (stdout + stderr).trim()
        const message = output || `Pulled ${remotePath} to ${localPath}`
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message }) }],
          structuredContent: { success: true, message },
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

  server.registerTool(
    "file_list",
    {
      description: "List directory contents on the device.",
      inputSchema: {
        path: z.string().describe("Absolute path to the directory on the device (e.g., /sdcard/)"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        path: z.string().describe("The directory that was listed"),
        count: z.number().int().describe("Number of entries returned"),
        entries: z.array(
          z.object({
            name: z.string().describe("Entry name"),
            permissions: z.string().describe("Permission string (e.g. -rw-r--r--)"),
            owner: z.string().describe("Owner user"),
            group: z.string().describe("Owner group"),
            size: z.number().describe("Size in bytes (0 for special files)"),
            date: z.string().describe("Modification date/time"),
            isDirectory: z.boolean().describe("Whether the entry is a directory"),
          })
        ).describe("Directory entries"),
      },
      annotations: {
        title: "List Directory",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ path: devicePath, serial }) => {
      try {
        const s = await resolveSerial(serial)
        const safePath = devicePath.replace(/'/g, "'\\''")
        // -H dereferences only the operand, so a symlinked directory such as
        // /sdcard (-> /storage/self/primary) lists its target's contents rather
        // than the link itself. Do NOT use -L: it dereferences every entry too,
        // and a single dangling symlink makes ls print an error and exit 1,
        // which execAdb turns into a rejection for the whole directory.
        const output = await execAdbShell(s, `ls -laH '${safePath}'`)
        const entries = parseLsOutput(output)
        const structured = { path: devicePath, count: entries.length, entries }
        return {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
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
