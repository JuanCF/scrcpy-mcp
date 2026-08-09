import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

describe("Input Tools Integration", () => {
  beforeAll(async () => {
    await connectClient()
  }, 30000)

  afterAll(async () => {
    await disconnectClient()
  })

  describe("screen_on", () => {
    it("should turn screen on", async () => {
      const result = await callTool("screen_on")
      const text = String(parseResult(result))
      expect(text).toContain("on")
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

  describe("long_press", () => {
    it("should long press at coordinates", async () => {
      const result = await callTool("long_press", { x: 500, y: 500, duration: 500 })
      const text = String(parseResult(result))
      expect(text).toContain("Long pressed")
      expect(text).toContain("500")
    })
  })

  describe("drag_drop", () => {
    it("should perform a drag and drop gesture", async () => {
      const result = await callTool("drag_drop", {
        startX: 100,
        startY: 500,
        endX: 100,
        endY: 200,
        duration: 300,
      })
      const text = String(parseResult(result))
      expect(text).toContain("Dragged")
    })
  })

  describe("input_text", () => {
    it("should type text into the focused field", async () => {
      // Go HOME first so the launcher holds focus and the text cannot land in
      // some real app's text field left focused by an earlier test. This is a
      // round-trip smoke test of the tool only: it deliberately does not assert
      // that the keystrokes reached the device, since there is no text field to
      // read them back from.
      await callTool("key_event", { keycode: "HOME" })

      const result = await callTool("input_text", { text: "scrcpy-mcp-test" })
      const text = String(parseResult(result))
      expect(text).toContain("Typed:")
      expect(text).toContain("scrcpy-mcp-test")
    })
  })

  describe("scroll", () => {
    it("should scroll at coordinates", async () => {
      const result = await callTool("scroll", { x: 500, y: 500, dx: 0, dy: -1 })
      const text = String(parseResult(result))
      expect(text).toContain("Scrolled")
    })
  })
})
