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
      /^([dlbcsp-][rwxst-]{9}[+.]?)\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/
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
      size: parseInt(sizeStr, 10),
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
    },
    async ({ localPath, remotePath, serial }) => {
      try {
        if (!nodePath.isAbsolute(localPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: true, message: "localPath must be an absolute path" }),
            }],
          }
        }
        if (!fs.existsSync(localPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: true, message: `File not found: ${localPath}` }),
            }],
          }
        }
        const s = await resolveSerial(serial)
        const { stdout, stderr } = await execAdb(["-s", s, "push", localPath, remotePath])
        const output = (stdout + stderr).trim()
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, message: output || `Pushed ${localPath} to ${remotePath}` }),
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
    "file_pull",
    {
      description: "Pull a file from the device to the host machine.",
      inputSchema: {
        remotePath: z.string().describe("Path to the file on the device (e.g., /sdcard/myfile.txt)"),
        localPath: z.string().describe("Destination absolute path on the host machine"),
        serial: z.string().optional().describe("Device serial number"),
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
          }
        }
        const s = await resolveSerial(serial)
        const { stdout, stderr } = await execAdb(["-s", s, "pull", remotePath, localPath])
        const output = (stdout + stderr).trim()
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, message: output || `Pulled ${remotePath} to ${localPath}` }),
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
    "file_list",
    {
      description: "List directory contents on the device.",
      inputSchema: {
        path: z.string().describe("Absolute path to the directory on the device (e.g., /sdcard/)"),
        serial: z.string().optional().describe("Device serial number"),
      },
    },
    async ({ path: devicePath, serial }) => {
      try {
        const s = await resolveSerial(serial)
        const output = await execAdbShell(s, `ls -la "${devicePath}"`)
        const entries = parseLsOutput(output)
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ path: devicePath, count: entries.length, entries }),
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
