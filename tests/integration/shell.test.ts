import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

describe("Shell and Version Tools Integration", () => {
  beforeAll(async () => {
    await connectClient()
  }, 30000)

  afterAll(async () => {
    await disconnectClient()
  })

  describe("shell_exec", () => {
    it("should execute a shell command and return output", async () => {
      const result = await callTool("shell_exec", {
        command: "echo 'scrcpy-mcp-shell-test'",
      })
      const output = String(parseResult(result))

      expect(output).toContain("scrcpy-mcp-shell-test")
    })
  })

  describe("version", () => {
    it("should report the scrcpy version", async () => {
      const result = await callTool("version")
      const output = String(parseResult(result))

      expect(output).toContain("source:")
      expect(output.length).toBeGreaterThan(0)
    })
  })
})
