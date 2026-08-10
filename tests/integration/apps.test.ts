import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult, stopSessionOrFail } from "./mcp-client.js"

const SETTINGS_PACKAGE = "com.android.settings"

interface CurrentApp {
  packageName: string
  activity: string | null
}

/**
 * Poll app_current until it reports `expected`, or the timeout elapses.
 *
 * Always resolves with the last reading so the caller's assertion reports the
 * package that was actually in the foreground, rather than a bare timeout.
 */
async function waitForForegroundApp(
  expected: string,
  timeoutMs = 10000,
  intervalMs = 500
): Promise<CurrentApp> {
  const deadline = Date.now() + timeoutMs
  let last: CurrentApp

  for (;;) {
    last = parseResult(await callTool("app_current")) as CurrentApp
    if (last.packageName === expected || Date.now() >= deadline) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

describe("App Tools Integration", () => {
  beforeAll(async () => {
    await connectClient()
    await callTool("screen_on")
  }, 30000)

  afterAll(async () => {
    // Insurance for the app_start fast-path session: if its own afterAll threw,
    // the device would stay busy and every later file's start_session would fail.
    // Disconnect in a finally so a failed stop still tears the server down —
    // otherwise the stdio child outlives the run and vitest hangs on it.
    try {
      await stopSessionOrFail()
    } finally {
      await disconnectClient()
    }
  }, 30000)

  describe("app_list", () => {
    it("should list installed packages", async () => {
      const result = await callTool("app_list")
      const parsed = parseResult(result) as {
        count: number
        packages: string[]
      }

      expect(parsed.count).toBeGreaterThan(0)
      expect(parsed.packages.length).toBe(parsed.count)
      expect(parsed.packages.length).toBeGreaterThan(0)
    })

    it("should filter installed packages", async () => {
      const result = await callTool("app_list", { filter: "android" })
      const parsed = parseResult(result) as {
        count: number
        packages: string[]
      }

      expect(parsed.packages.length).toBeGreaterThan(0)
      expect(parsed.packages.every((p) => p.toLowerCase().includes("android"))).toBe(true)
    })

    it("should list system packages only", async () => {
      const result = await callTool("app_list", { system: true })
      const parsed = parseResult(result) as {
        count: number
        packages: string[]
      }

      expect(parsed.count).toBeGreaterThan(0)
    })
  })

  // app_start has two execution paths: the scrcpy control-socket fast path when a
  // session is live, and the ADB `monkey` fallback otherwise. Both report the same
  // success message, so `source` is the only thing that tells them apart — hence a
  // case per path, each asserting it.
  describe("app_start", () => {
    it("should launch the Settings app via ADB when no session is active", async () => {
      // This file's server process starts out sessionless, but say so explicitly:
      // a leftover session would route this through the fast path instead and the
      // fallback would go untested without the assertion below ever failing.
      await stopSessionOrFail()

      const result = await callTool("app_start", { packageName: SETTINGS_PACKAGE })
      const parsed = parseResult(result) as {
        success: boolean
        message: string
        source?: string
      }

      expect(parsed.success).toBe(true)
      expect(parsed.message).toContain(SETTINGS_PACKAGE)
      expect(parsed.source).toBe("adb")
    }, 30000)

    describe("with an active scrcpy session", () => {
      let sessionStarted = false

      beforeAll(async () => {
        const result = await callTool("start_session", { maxSize: 800, maxFps: 15 })
        const data = parseResult(result) as { status: string; message?: string }
        // Surface the server-side message: without a connected session this
        // describe would be testing the fallback path a second time.
        expect(data.status, `start_session failed: ${data.message}`).toBe("connected")
        sessionStarted = true
      }, 30000)

      afterAll(async () => {
        // The device allows only one encoder session, so hand it back before the
        // remaining files (session.test.ts included) try to open their own.
        if (sessionStarted) await stopSessionOrFail()
      }, 30000)

      it("should launch the Settings app via scrcpy", async () => {
        const result = await callTool("app_start", { packageName: SETTINGS_PACKAGE })
        const parsed = parseResult(result) as {
          success: boolean
          message: string
          source?: string
        }

        expect(parsed.success).toBe(true)
        expect(parsed.message).toContain(SETTINGS_PACKAGE)
        // "adb" here would mean startAppViaScrcpy threw and the handler quietly
        // fell back: the launch still succeeds, so only `source` exposes that the
        // fast path is broken.
        expect(parsed.source).toBe("scrcpy")
      }, 30000)
    })
  })

  describe("app_current", () => {
    it("should return the foreground app", async () => {
      await callTool("app_start", { packageName: SETTINGS_PACKAGE })

      // app_start fires `monkey -p ...` and returns without waiting for the
      // activity to resume, so poll instead of reading app_current once — the
      // launcher can still be the resumed activity for a moment after.
      const parsed = await waitForForegroundApp(SETTINGS_PACKAGE)

      expect(parsed.packageName).toBe(SETTINGS_PACKAGE)
      expect(typeof parsed.activity === "string" || parsed.activity === null).toBe(true)
    }, 30000)
  })

  describe("app_stop", () => {
    it("should force-stop the Settings app", async () => {
      const result = await callTool("app_stop", { packageName: SETTINGS_PACKAGE })
      const parsed = parseResult(result) as {
        success: boolean
        message: string
      }

      expect(parsed.success).toBe(true)
      expect(parsed.message.toLowerCase()).toContain("stopped")
    })
  })

  describe("app_install validation", () => {
    it("should reject a missing APK file", async () => {
      const result = await callTool("app_install", {
        apkPath: "/nonexistent/scrcpy-mcp-test.apk",
      })
      const parsed = parseResult(result) as {
        error?: boolean
        message: string
      }

      expect(result.isError || parsed.error).toBe(true)
      expect(parsed.message).toContain("does not exist")
    })
  })

  describe("app_uninstall validation", () => {
    it("should reject an invalid package name", async () => {
      const result = await callTool("app_uninstall", {
        packageName: "not a valid package",
      })
      const parsed = parseResult(result) as {
        error?: boolean
        message: string
      }

      expect(result.isError || parsed.error).toBe(true)
    })
  })

  const testApkPath = process.env.TEST_APK_PATH
  const testApkPackage = process.env.TEST_APK_PACKAGE
  const canRunInstallRoundTrip = Boolean(testApkPath && testApkPackage)

  describe.skipIf(!canRunInstallRoundTrip)("app_install / app_uninstall round-trip", () => {
    it("should install and uninstall the test APK", async () => {
      const installResult = await callTool("app_install", { apkPath: testApkPath })
      const installParsed = parseResult(installResult) as {
        success: boolean
        message: string
      }
      expect(installParsed.success).toBe(true)

      // Past this point the APK is on the device, so the uninstall has to happen
      // even if the assertion below fails — otherwise a red run leaves the test
      // app installed and the next run's install is no longer a clean one.
      try {
        const uninstallResult = await callTool("app_uninstall", { packageName: testApkPackage })
        const uninstallParsed = parseResult(uninstallResult) as {
          success: boolean
          message: string
        }
        expect(uninstallParsed.success).toBe(true)
      } finally {
        // No-op when the uninstall above succeeded; the package is already gone.
        await callTool("app_uninstall", { packageName: testApkPackage }).catch(() => {})
      }
    }, 60000)
  })
})
