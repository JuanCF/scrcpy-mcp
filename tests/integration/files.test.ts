import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

describe("File Tools Integration", () => {
  const timestamp = Date.now()
  const testFileName = `scrcpy-mcp-file-test-${timestamp}.txt`
  const localSource = path.join(os.tmpdir(), testFileName)
  const localDownload = path.join(os.tmpdir(), `downloaded-${testFileName}`)
  const remotePath = `/sdcard/${testFileName}`
  const testContent = "Hello from scrcpy-mcp integration tests!"

  beforeAll(async () => {
    await connectClient()
    fs.writeFileSync(localSource, testContent, "utf8")
  }, 30000)

  afterAll(async () => {
    try {
      fs.unlinkSync(localSource)
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(localDownload)
    } catch {
      // ignore
    }
    try {
      await callTool("shell_exec", { command: `rm -f ${remotePath}` })
    } catch {
      // ignore
    }
    await disconnectClient()
  })

  describe("file_push", () => {
    it("should push a file to the device", async () => {
      const result = await callTool("file_push", {
        localPath: localSource,
        remotePath,
      })
      const parsed = parseResult(result) as {
        success: boolean
        message: string
      }

      expect(parsed.success).toBe(true)
      expect(parsed.message.toLowerCase()).toContain("push")
    })
  })

  describe("file_list", () => {
    it("should list the sdcard directory", async () => {
      const result = await callTool("file_list", { path: "/sdcard" })
      const parsed = parseResult(result) as {
        path: string
        count: number
        entries: Array<{
          name: string
          permissions: string
          isDirectory: boolean
        }>
      }

      expect(parsed.path).toBe("/sdcard")
      expect(parsed.count).toBeGreaterThan(0)
      expect(parsed.entries.length).toBe(parsed.count)
    })

    it("should include the pushed file", async () => {
      const result = await callTool("file_list", { path: "/sdcard" })
      const parsed = parseResult(result) as {
        count: number
        entries: Array<{ name: string }>
      }

      expect(parsed.entries.some((e) => e.name === testFileName)).toBe(true)
    })
  })

  describe("file_pull", () => {
    it("should pull the file back to the host", async () => {
      const result = await callTool("file_pull", {
        remotePath,
        localPath: localDownload,
      })
      const parsed = parseResult(result) as {
        success: boolean
        message: string
      }

      expect(parsed.success).toBe(true)
      expect(fs.existsSync(localDownload)).toBe(true)
      expect(fs.readFileSync(localDownload, "utf8")).toBe(testContent)
    })
  })
})
