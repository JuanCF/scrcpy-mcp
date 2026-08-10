import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, expectActionOk } from "./mcp-client.js"

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
    // screen_on alone wakes the display but leaves the keyguard up, so try to
    // dismiss it too. On a device with a PIN/pattern/password this cannot
    // succeed — `wm dismiss-keyguard` still exits 0 — and the device stays
    // locked for the rest of the run. Every other file's beforeAll wakes the
    // screen and its tools work behind the lock, so that is not fatal.
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
      expect(expectActionOk(result).message).toContain("off")
    })
  })
})
