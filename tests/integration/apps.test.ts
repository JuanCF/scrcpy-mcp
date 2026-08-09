import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

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
  let last: CurrentApp = { packageName: "", activity: null }

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
    await disconnectClient()
  })

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

  describe("app_start", () => {
    it("should launch the Settings app", async () => {
      const result = await callTool("app_start", { packageName: SETTINGS_PACKAGE })
      const parsed = parseResult(result) as {
        success: boolean
        message: string
      }

      expect(parsed.success).toBe(true)
      expect(parsed.message).toContain(SETTINGS_PACKAGE)
    }, 30000)
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

      const uninstallResult = await callTool("app_uninstall", { packageName: testApkPackage })
      const uninstallParsed = parseResult(uninstallResult) as {
        success: boolean
        message: string
      }
      expect(uninstallParsed.success).toBe(true)
    }, 60000)
  })
})
