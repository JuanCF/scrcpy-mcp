import { describe, it, expect, beforeAll } from "vitest"
import { resolveSerial, execAdbShell } from "../../src/utils/adb.js"
import { callTool, stopSessionOrFail } from "./mcp-client.js"

describe("audio tools", () => {
  let serial: string | null = null
  let sdk = 0
  let skipped = false

  beforeAll(async () => {
    try {
      serial = await resolveSerial()
      const sdkText = await execAdbShell(serial, "getprop ro.build.version.sdk")
      sdk = Number.parseInt(sdkText.trim(), 10)
      if (Number.isNaN(sdk) || sdk < 30) {
        skipped = true
      }
    } catch {
      skipped = true
    }
  })

  it("starts and stops an audio recording", async () => {
    if (skipped || !serial) return

    await stopSessionOrFail()

    // A failed assertion must not strand the ffmpeg child or the scrcpy
    // session — later tests would inherit both.
    let recordingStarted = false
    try {
      const startResult = await callTool("audio_record_start", { serial })
      expect(startResult.isError).toBeFalsy()
      const startData = startResult.structuredContent as {
        status: string
        localPath: string
        format: string
        deviceMuted: boolean
        sessionRestarted: boolean
        message: string
      }
      expect(startData, "audio_record_start returned no structuredContent").toBeDefined()
      expect(startData.status).toBe("recording")
      expect(startData.sessionRestarted).toBe(true)
      recordingStarted = true

      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stopResult = await callTool("audio_record_stop", { serial })
      expect(stopResult.isError).toBeFalsy()
      const stopData = stopResult.structuredContent as {
        status: string
        localPath: string
        sizeBytes: number
        durationSeconds: number
        message: string
      }
      expect(stopData, "audio_record_stop returned no structuredContent").toBeDefined()
      expect(stopData.status).toBe("stopped")
      expect(stopData.sizeBytes).toBeGreaterThan(0)
      recordingStarted = false
    } finally {
      if (recordingStarted) {
        await callTool("audio_record_stop", { serial })
      }
      await stopSessionOrFail()
    }
  }, 60000)
})
