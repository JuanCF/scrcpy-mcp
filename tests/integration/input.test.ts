import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

describe("Input Tools Integration", () => {
  beforeAll(async () => {
    await connectClient()
  }, 30000)

  afterAll(async () => {
    await disconnectClient()
  })

  describe("screen_on / screen_off", () => {
    it("should turn screen on", async () => {
      const result = await callTool("screen_on")
      const text = String(parseResult(result))
      expect(text).toContain("on")
    })

    it("should turn screen off", async () => {
      const result = await callTool("screen_off")
      const text = String(parseResult(result))
      expect(text).toContain("off")
    })
  })

  describe("key_event", () => {
    it("should send HOME key event", async () => {
      const result = await callTool("key_event", { keycode: "HOME" })
      const text = String(parseResult(result))
      expect(text).toContain("HOME")
    })

    it("should send BACK key event", async () => {
      const result = await callTool("key_event", { keycode: "BACK" })
      const text = String(parseResult(result))
      expect(text).toContain("BACK")
    })
  })

  describe("tap", () => {
    it("should tap at coordinates", async () => {
      const result = await callTool("tap", { x: 500, y: 500 })
      const text = String(parseResult(result))
      expect(text).toContain("500")
    })
  })

  describe("swipe", () => {
    it("should perform swipe gesture", async () => {
      const result = await callTool("swipe", {
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        duration: 300,
      })
      const text = String(parseResult(result))
      expect(text).toContain("Swiped")
    })
  })
})
