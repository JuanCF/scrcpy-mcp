import { describe, it, expect, beforeAll } from "vitest"
import { resolveSerial, execAdbShell } from "../../src/utils/adb.js"
import { callTool, parseResult, stopSessionOrFail } from "./mcp-client.js"

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

    const startResult = await callTool("audio_record_start", { serial })
    const startData = parseResult(startResult) as {
      status: string
      localPath: string
      sessionRestarted?: boolean
    }
    expect(startData.status).toBe("recording")
    expect(startData.sessionRestarted).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 1500))

    const stopResult = await callTool("audio_record_stop", { serial })
    const stopData = parseResult(stopResult) as {
      status: string
      localPath: string
      sizeBytes: number
      durationSeconds: number
    }
    expect(stopData.status).toBe("stopped")
    expect(stopData.sizeBytes).toBeGreaterThan(0)

    await stopSessionOrFail()
  }, 60000)
})
