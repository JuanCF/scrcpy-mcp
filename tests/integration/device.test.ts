import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

describe("Device Tools Integration", () => {
  beforeAll(async () => {
    await connectClient()
  }, 30000)

  afterAll(async () => {
    await disconnectClient()
  })

  describe("device_list", () => {
    it("should list connected devices", async () => {
      const result = await callTool("device_list")
      const devices = parseResult(result) as Array<{
        serial: string
        state: string
        model?: string
      }>

      expect(Array.isArray(devices)).toBe(true)
      expect(devices.length).toBeGreaterThan(0)

      const device = devices[0]
      expect(device).toHaveProperty("serial")
      expect(device).toHaveProperty("state")
      expect(device.state).toBe("device")
    })
  })

  describe("device_info", () => {
    it("should get device info", async () => {
      const result = await callTool("device_info")
      const info = parseResult(result) as {
        serial: string
        model: string | null
        androidVersion: string | null
        sdkLevel: number | null
        screenWidth: number
        screenHeight: number
      }

      expect(info).toHaveProperty("serial")
      expect(info).toHaveProperty("screenWidth")
      expect(info).toHaveProperty("screenHeight")
      expect(typeof info.screenWidth).toBe("number")
      expect(typeof info.screenHeight).toBe("number")
      expect(info.screenWidth).toBeGreaterThan(0)
      expect(info.screenHeight).toBeGreaterThan(0)
    })
  })
})
