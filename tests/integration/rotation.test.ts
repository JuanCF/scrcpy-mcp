import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { connectClient, disconnectClient, callTool, parseResult, stopSessionOrFail } from "./mcp-client.js"

// Regression coverage for issue #66: touches must land where they were aimed
// when the display is not in its natural orientation, both when a session
// starts that way and when the device rotates while a session is running.
//
// The check is an end-to-end one because the failure is silent — `tap` reports
// success whether or not the touch arrived. So each case taps a row of the
// Settings home page and asserts that the page carrying that row's title
// opened. Rows are picked by resource id and compared by the text read off the
// device, so nothing here depends on the device's language.

const SETTINGS_PACKAGE = "com.android.settings"
const ROTATION_SETTLE_MS = 8000
const PAGE_SETTLE_MS = 5000

interface Size {
  width: number
  height: number
}

interface SessionInfo {
  status: string
  message?: string
  screenSize: Size
  videoAvailable: boolean
}

interface FoundElements {
  count: number
  elements: Array<{ text: string; tapX: number; tapY: number }>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
  description: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await sleep(250)
  }
}

async function shell(command: string): Promise<string> {
  const result = await callTool("shell_exec", { command })
  expect(result.isError, `shell_exec failed: ${command}`).toBeFalsy()
  return (result.structuredContent as { output: string }).output.trim()
}

/** The display's rotation in quarter turns, as uiautomator reports it. */
async function displayRotation(): Promise<number> {
  const xml = String(parseResult(await callTool("ui_dump")))
  const match = xml.match(/<hierarchy[^>]*\brotation="(\d)"/)
  if (!match) throw new Error("ui_dump returned no hierarchy rotation")
  return parseInt(match[1], 10)
}

async function rotateTo(rotation: number): Promise<void> {
  await shell(
    "settings put system accelerometer_rotation 0; " +
      `settings put system user_rotation ${rotation}`
  )
  await waitFor(`the display to reach rotation ${rotation}`, ROTATION_SETTLE_MS, async () =>
    (await displayRotation()) === rotation ? true : undefined
  )
}

async function foregroundActivity(): Promise<string> {
  const current = parseResult(await callTool("app_current")) as {
    packageName: string
    activity: string | null
  }
  return `${current.packageName}/${current.activity}`
}

async function settingsRows(): Promise<FoundElements["elements"]> {
  const found = parseResult(
    await callTool("ui_find_element", { resourceId: "android:id/title" })
  ) as FoundElements
  return found.elements.filter((element) => element.text.length > 0)
}

/** Force-stop and relaunch Settings so every case starts from its home page. */
async function openSettingsHome(): Promise<string> {
  await callTool("app_start", { packageName: `+${SETTINGS_PACKAGE}` })
  await waitFor("the Settings home page", PAGE_SETTLE_MS, async () =>
    (await settingsRows()).length > 0 ? true : undefined
  )
  return foregroundActivity()
}

/**
 * Tap the first Settings row at the coordinates ui_find_element gives for it
 * and assert that the page it leads to is the one that opened.
 */
async function expectTapOpensFirstRow(): Promise<void> {
  const homeActivity = await openSettingsHome()
  const [row] = await settingsRows()
  expect(row, "Settings home page shows no rows to tap").toBeDefined()

  const tapped = await callTool("tap", { x: row.tapX, y: row.tapY })
  expect(tapped.isError, `tap failed: ${JSON.stringify(tapped.content)}`).toBeFalsy()

  const target = `"${row.text}" at (${row.tapX}, ${row.tapY})`
  await waitFor(`the tap on ${target} to leave the Settings home page`, PAGE_SETTLE_MS, async () =>
    (await foregroundActivity()) !== homeActivity ? true : undefined
  )
  const title = parseResult(await callTool("ui_find_element", { text: row.text })) as FoundElements
  expect(title.count, `tap on ${target} opened a different page`).toBeGreaterThan(0)
}

describe("Touch mapping across rotation", () => {
  let naturalSize: Size
  let previousAutoRotate: string | null = null
  let previousUserRotation: string | null = null
  // The mapping follows the video stream, so a device that cannot produce one
  // (CI's software-rendered emulator) has nothing for these cases to check.
  let videoAvailable = false

  const sizeAt = (rotation: number): Size =>
    rotation % 2 === 0 ? naturalSize : { width: naturalSize.height, height: naturalSize.width }

  // start_session hands back the running session when the options match, so
  // calling it again reads the size the session currently maps touches against.
  const sessionInfo = async (): Promise<SessionInfo> =>
    parseResult(await callTool("start_session")) as SessionInfo

  beforeAll(async () => {
    await connectClient()
    await callTool("screen_on")

    previousAutoRotate = await shell("settings get system accelerometer_rotation")
    previousUserRotation = await shell("settings get system user_rotation")

    const info = parseResult(await callTool("device_info")) as {
      screenWidth: number
      screenHeight: number
    }
    naturalSize = { width: info.screenWidth, height: info.screenHeight }

    // Settings follows the display's rotation where a launcher often does not,
    // so it has to be in front before the display will turn.
    await openSettingsHome()
    await rotateTo(1)
  }, 60000)

  afterAll(async () => {
    const restore = async (key: string, value: string | null): Promise<void> => {
      if (value === null) return
      // `settings get` prints "null" for a key that was never set.
      await shell(
        value === "null" ? `settings delete system ${key}` : `settings put system ${key} ${value}`
      )
    }
    try {
      await restore("user_rotation", previousUserRotation)
      await restore("accelerometer_rotation", previousAutoRotate)
      await callTool("key_event", { keycode: "HOME" })
      await stopSessionOrFail()
    } finally {
      await disconnectClient()
    }
  }, 30000)

  // Order-dependent: the first case starts the session the others reuse.
  it("reports the native size as rotated when a session starts in landscape", async ({ skip }) => {
    const session = await sessionInfo()
    expect(session.status, `start_session failed: ${session.message}`).toBe("connected")
    videoAvailable = session.videoAvailable
    skip(!videoAvailable, "no video stream on this device")

    expect(session.screenSize).toEqual(sizeAt(1))
  }, 30000)

  it("lands a tap on its target when the session started in landscape", async ({ skip }) => {
    skip(!videoAvailable, "no video stream on this device")
    await expectTapOpensFirstRow()
  }, 30000)

  it("follows a rotation made while the session is running", async ({ skip }) => {
    skip(!videoAvailable, "no video stream on this device")
    await openSettingsHome()
    await rotateTo(0)

    // The session learns the new size from the stream, a moment after the
    // display itself has turned.
    await waitFor("the session to report the upright size", ROTATION_SETTLE_MS, async () => {
      const { screenSize } = await sessionInfo()
      return screenSize.width === sizeAt(0).width && screenSize.height === sizeAt(0).height
        ? true
        : undefined
    })
    await expectTapOpensFirstRow()
  }, 45000)

  it("lands a tap on its target after rotating back to landscape", async ({ skip }) => {
    skip(!videoAvailable, "no video stream on this device")
    await openSettingsHome()
    await rotateTo(1)

    await waitFor("the session to report the landscape size", ROTATION_SETTLE_MS, async () => {
      const { screenSize } = await sessionInfo()
      return screenSize.width === sizeAt(1).width && screenSize.height === sizeAt(1).height
        ? true
        : undefined
    })
    await expectTapOpensFirstRow()
  }, 45000)
})
