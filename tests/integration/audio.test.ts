import { describe, it, expect, beforeAll } from "vitest"
import * as fs from "fs"
import { resolveSerial, execAdbShell, execAdb } from "../../src/utils/adb.js"
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
        stoppedReason: string
        message: string
      }
      expect(stopData, "audio_record_stop returned no structuredContent").toBeDefined()
      expect(stopData.status).toBe("stopped")
      expect(stopData.stoppedReason).toBe("user")
      expect(stopData.sizeBytes).toBeGreaterThan(0)
      recordingStarted = false
    } finally {
      if (recordingStarted) {
        await callTool("audio_record_stop", { serial })
      }
      await stopSessionOrFail()
    }
  }, 60000)

  it("captures a bounded audio clip as an audio content block", async () => {
    if (skipped || !serial) return

    await stopSessionOrFail()

    try {
      const result = await callTool("audio_capture", { serial, durationSeconds: 2 })
      expect(result.isError).toBeFalsy()
      expect(result.content).toBeDefined()
      const audioBlock = result.content?.find((c) => c.type === "audio")
      expect(audioBlock, "expected an audio content block").toBeDefined()
      if (audioBlock?.type === "audio") {
        expect(audioBlock.data).toBeTruthy()
        expect(audioBlock.mimeType).toMatch(/^audio\//)
      }

      const structured = result.structuredContent as {
        status: string
        durationSeconds: number
        sizeBytes: number
        mimeType: string
      }
      expect(structured.status).toBe("captured")
      expect(structured.sizeBytes).toBeGreaterThan(0)
    } finally {
      await stopSessionOrFail()
    }
  }, 60000)

  it("captures a clip during an active recording without disturbing the recording", async () => {
    if (skipped || !serial) return

    await stopSessionOrFail()

    let recordingStarted = false
    try {
      const recStart = await callTool("audio_record_start", { serial })
      expect(recStart.isError).toBeFalsy()
      recordingStarted = true

      await new Promise((resolve) => setTimeout(resolve, 500))

      const clipResult = await callTool("audio_capture", { serial, durationSeconds: 1 })
      expect(clipResult.isError).toBeFalsy()
      const audioBlock = clipResult.content?.find((c) => c.type === "audio")
      expect(audioBlock).toBeDefined()

      await new Promise((resolve) => setTimeout(resolve, 500))

      const recStop = await callTool("audio_record_stop", { serial })
      expect(recStop.isError).toBeFalsy()
      const stopData = recStop.structuredContent as { status: string; sizeBytes: number; stoppedReason: string }
      expect(stopData.status).toBe("stopped")
      expect(stopData.stoppedReason).toBe("user")
      expect(stopData.sizeBytes).toBeGreaterThan(0)
      recordingStarted = false
    } finally {
      if (recordingStarted) {
        await callTool("audio_record_stop", { serial })
      }
      await stopSessionOrFail()
    }
  }, 60000)

  it("finalises a recording automatically when maxDuration elapses", async () => {
    if (skipped || !serial) return

    await stopSessionOrFail()

    let recordingStarted = false
    try {
      const recStart = await callTool("audio_record_start", { serial, maxDuration: 2 })
      expect(recStart.isError).toBeFalsy()
      recordingStarted = true

      // Wait for the timer to fire; do not call audio_record_stop.
      await new Promise((resolve) => setTimeout(resolve, 3500))

      const recStop = await callTool("audio_record_stop", { serial })
      expect(recStop.isError).toBeFalsy()
      const stopData = recStop.structuredContent as { status: string; sizeBytes: number; stoppedReason: string }
      expect(stopData.status).toBe("stopped")
      expect(stopData.stoppedReason).toBe("maxDuration")
      expect(stopData.sizeBytes).toBeGreaterThan(0)
      recordingStarted = false
    } finally {
      if (recordingStarted) {
        await callTool("audio_record_stop", { serial })
      }
      await stopSessionOrFail()
    }
  }, 60000)

  it("keeps a playable partial recording when the device is lost mid-recording", async () => {
    if (skipped || !serial) return

    await stopSessionOrFail()

    let recordingStarted = false
    try {
      const recStart = await callTool("audio_record_start", { serial })
      expect(recStart.isError).toBeFalsy()
      const startData = recStart.structuredContent as { localPath: string }
      recordingStarted = true

      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Simulate device loss by disconnecting ADB. This only works for
      // wireless ADB; skip gracefully if the device is USB.
      try {
        await execAdb(["disconnect", serial])
      } catch {
        // USB devices cannot be adb-disconnected; stop the recording cleanly
        // and mark the test as skipped.
        await callTool("audio_record_stop", { serial })
        recordingStarted = false
        return
      }

      // Give the hub time to notice the socket is gone.
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Reconnect so we can ask the tool for the result.
      try {
        await execAdb(["connect", serial])
      } catch {
        // If reconnect fails we cannot retrieve the result; at least verify
        // the partial file survived on disk.
      }

      const recStop = await callTool("audio_record_stop", { serial })
      if (recStop.isError) {
        // The partial file should still exist even if the stop call could not
        // find an in-memory recording entry.
        expect(fs.existsSync(startData.localPath)).toBe(true)
      } else {
        const stopData = recStop.structuredContent as { status: string; sizeBytes: number; stoppedReason: string }
        expect(stopData.status).toBe("stopped")
        expect(stopData.stoppedReason).toBe("deviceLost")
        expect(stopData.sizeBytes).toBeGreaterThan(0)
      }
      recordingStarted = false
    } finally {
      await stopSessionOrFail()
    }
  }, 120000)
})
