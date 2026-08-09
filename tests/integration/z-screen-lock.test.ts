import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

// Turning the screen off locks most devices, which would break every later
// file. Do NOT rely on the filename to defer this: Vitest's BaseSequencer
// orders files by previous failure, then duration, then size — never by name —
// so this file can run first. It restores the screen itself instead, which
// makes the ordering irrelevant.
describe("Screen Lock Tool Integration", () => {
  beforeAll(async () => {
    await connectClient()
  }, 30000)

  afterAll(async () => {
    // KEYCODE_WAKEUP alone wakes the display but leaves the keyguard up, so
    // dismiss it explicitly.
    try {
      await callTool("screen_on")
      await callTool("shell_exec", { command: "wm dismiss-keyguard" })
    } catch {
      // ignore
    }
    await disconnectClient()
  }, 30000)

  describe("screen_off", () => {
    it("should turn screen off", async () => {
      const result = await callTool("screen_off")
      const text = String(parseResult(result))
      expect(text).toContain("off")
    })
  })
})
