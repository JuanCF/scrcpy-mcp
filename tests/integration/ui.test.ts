import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

describe("UI Tools Integration", () => {
  beforeAll(async () => {
    await connectClient()
    await callTool("screen_on")
  }, 30000)

  afterAll(async () => {
    await disconnectClient()
  })

  describe("ui_dump", () => {
    it("should dump the current UI hierarchy as XML", async () => {
      const result = await callTool("ui_dump")
      const xml = String(parseResult(result))

      expect(xml.length).toBeGreaterThan(0)
      expect(xml.startsWith("<")).toBe(true)
      expect(xml).toContain("node")
    })
  })

  describe("ui_find_element", () => {
    it("should find FrameLayout nodes on the screen", async () => {
      const result = await callTool("ui_find_element", {
        className: "android.widget.FrameLayout",
      })
      const parsed = parseResult(result) as {
        count: number
        elements: Array<{
          className: string
          tapX: number
          tapY: number
          clickable: boolean
        }>
      }

      expect(parsed.count).toBeGreaterThan(0)
      expect(parsed.elements.length).toBe(parsed.count)
      expect(parsed.elements[0]).toHaveProperty("tapX")
      expect(parsed.elements[0]).toHaveProperty("tapY")
    })
  })
})
