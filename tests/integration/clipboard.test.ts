import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

// Reading the clipboard requires the scrcpy control path available on API 31+.
// Probe through the MCP client rather than a bare `adb` from PATH, so the same
// device (and the same ADB_PATH) is used as by every other call in the suite.
// A failed probe must fail the run, not silently skip the read tests green.
let sdkLevel = 0

describe("Clipboard Tools Integration", () => {
  beforeAll(async () => {
    await connectClient()

    const sdkResult = await callTool("shell_exec", {
      command: "getprop ro.build.version.sdk",
    })
    sdkLevel = parseInt(String(parseResult(sdkResult)).trim(), 10)
    expect(
      Number.isInteger(sdkLevel) && sdkLevel > 0,
      `could not read ro.build.version.sdk: ${String(parseResult(sdkResult))}`
    ).toBe(true)

    await callTool("start_session")
  }, 30000)

  afterAll(async () => {
    try {
      await callTool("stop_session")
    } catch {
      // ignore
    }
    await disconnectClient()
  }, 30000)

  const text = `scrcpy-mcp-clipboard-${Date.now()}`

  describe("clipboard_set", () => {
    it("should set the device clipboard", async () => {
      const result = await callTool("clipboard_set", { text })
      const parsed = parseResult(result) as {
        success: boolean
        message: string
        source: string
      }

      expect(parsed.success).toBe(true)
      expect(parsed.message).toContain(text)
      expect(["scrcpy", "adb"]).toContain(parsed.source)
    })
  })

  describe("clipboard_get", () => {
    // Skipped at runtime, not collection time: sdkLevel is only known after
    // beforeAll has run, so describe.skipIf would always see the initial 0.
    it("should read the device clipboard", async (ctx) => {
      if (sdkLevel < 31) {
        ctx.skip(`clipboard_get requires API 31+, device is API ${sdkLevel}`)
        return
      }

      await callTool("clipboard_set", { text })
      const result = await callTool("clipboard_get")
      const parsed = parseResult(result) as {
        content: string
        source: string
      }

      expect(parsed.content).toBe(text)
      expect(["scrcpy", "adb"]).toContain(parsed.source)
    })
  })
})
