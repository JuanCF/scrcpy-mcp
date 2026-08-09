import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

describe("Session Tools Integration", () => {
  // Set while the display is toggled away from its original orientation.
  let isRotated = false

  beforeAll(async () => {
    await connectClient()
  }, 30000)

  afterAll(async () => {
    if (isRotated) {
      try {
        await callTool("rotate_device")
      } catch {
        // Best effort — leave the device upright if we can
      }
    }
    try {
      await callTool("stop_session")
    } catch {
      // Ignore if no session
    }
    await disconnectClient()
  }, 30000)

  // Tests are order-dependent: start_session must run before screenshot, and stop_session must run last
  describe("start_session / stop_session", () => {
    it("should start a scrcpy session", async () => {
      const result = await callTool("start_session", {
        maxSize: 800,
        maxFps: 15,
      })
      const data = parseResult(result) as {
        status: string
        message?: string
        screenSize: { width: number; height: number }
      }

      // Surface the server-side message on failure so CI logs show the real
      // cause (e.g. a device-metadata timeout) instead of just "error".
      expect(data.status, `start_session failed: ${data.message}`).toBe("connected")
      expect(data.screenSize).toBeDefined()
      // screenSize reports the NATIVE display resolution (the coordinate space
      // tap/swipe use), not the downscaled max_size=800 video frame. So it is
      // independent of maxSize and is typically larger than it.
      expect(data.screenSize.width).toBeGreaterThan(0)
      expect(data.screenSize.height).toBeGreaterThan(0)
    }, 30000)

    it("should take a screenshot via scrcpy session", async () => {
      const result = await callTool("screenshot")

      expect(result.content).toBeDefined()
      expect(result.content.length).toBeGreaterThan(0)

      const imageContent = result.content.find((c) => c.type === "image")
      expect(imageContent).toBeDefined()
    }, 15000)

    it("should rotate the device", async () => {
      // rotate_device toggles, so a second call restores the original
      // orientation. Without it the rest of the suite — and the user's phone
      // once the run ends — is left sideways. The flag keeps that true even if
      // the assertion below throws, since afterAll then does the undo.
      await callTool("rotate_device").then((result) => {
        isRotated = true
        expect(String(parseResult(result))).toContain("rotated")
      })

      await callTool("rotate_device")
      isRotated = false
    })

    it("should expand the notification panel", async () => {
      const result = await callTool("expand_notifications")
      const text = String(parseResult(result))
      expect(text).toContain("Notification panel expanded")
    })

    it("should expand the quick settings panel", async () => {
      const result = await callTool("expand_settings")
      const text = String(parseResult(result))
      expect(text).toContain("Quick settings panel expanded")
    })

    it("should collapse panels", async () => {
      const result = await callTool("collapse_panels")
      const text = String(parseResult(result))
      expect(text).toContain("Panels collapsed")
    })

    it("should stop the session", async () => {
      const result = await callTool("stop_session")
      const text = parseResult(result)
      if (typeof text !== "string") {
        throw new Error(`Expected string response, got ${typeof text}`)
      }
      expect(text).toContain("stopped")
    }, 30000)
  })
})
