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
const ROW_SETTLE_MS = 15000

// Settings stacks cards above its list — a suggestion, for one, which Android 11
// starts showing only once the device is a few days old. A card's title carries
// the same resource id as a row's, but the page it opens does not repeat that
// title, so a card is no use as a tap target. These are the containers the
// cards sit in; which of them survive a compressed dump varies, hence several.
const SETTINGS_CARD_AREA = /<node\b[^>]*\bresource-id="com\.android\.settings:id\/(?:suggestion_card|card_container|contextual_cards_content)"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g

interface Size {
  width: number
  height: number
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

interface SessionInfo {
  status: string
  message?: string
  screenSize: Size
  videoAvailable: boolean
}

interface Row {
  text: string
  bounds: string
  tapX: number
  tapY: number
}

interface FoundElements {
  count: number
  elements: Row[]
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

/** Every titled entry on the Settings home page, cards included. */
async function settingsTitles(): Promise<Row[]> {
  const found = parseResult(
    await callTool("ui_find_element", { resourceId: "android:id/title" })
  ) as FoundElements
  return found.elements.filter((element) => element.text.length > 0)
}

async function settingsCardAreas(): Promise<Rect[]> {
  const xml = String(parseResult(await callTool("ui_dump")))
  return [...xml.matchAll(SETTINGS_CARD_AREA)].map((match) => {
    const [left, top, right, bottom] = match.slice(1).map(Number)
    return { left, top, right, bottom }
  })
}

/** The rows of the Settings list itself, leaving out any card above it. */
async function settingsRows(): Promise<Row[]> {
  // Cards first: one arriving between the two reads then shows up as a row,
  // which the next read corrects, instead of hiding the rows it displaced.
  const cards = await settingsCardAreas()
  const titles = await settingsTitles()
  const onCard = (row: Row): boolean =>
    cards.some(
      (card) =>
        row.tapX >= card.left &&
        row.tapX <= card.right &&
        row.tapY >= card.top &&
        row.tapY <= card.bottom
    )
  return titles.filter((row) => !onCard(row))
}

/**
 * Drag the Settings home page up. Sent through adb rather than the session so
 * that reaching a row does not depend on the touch mapping under test.
 */
async function scrollSettingsHome(): Promise<void> {
  const info = parseResult(await callTool("device_info")) as {
    screenWidth: number
    screenHeight: number
  }
  // Kept within the short side so the same drag fits either orientation.
  const side = Math.min(info.screenWidth, info.screenHeight)
  const x = Math.round(side / 2)
  await shell(`input swipe ${x} ${Math.round(side * 0.8)} ${x} ${Math.round(side * 0.3)} 500`)
}

/**
 * The first row of the Settings list, once two reads running find it in the
 * same place. The cards load after the list and push it down when they arrive,
 * so a row read too early would be tapped where it no longer is. On a short
 * landscape display a card can also fill the screen, hence the scroll.
 */
async function firstSettingsRow(): Promise<Row> {
  let previous: Row | undefined
  return waitFor("a Settings row that has stopped moving", ROW_SETTLE_MS, async () => {
    const [row] = await settingsRows()
    if (!row) {
      previous = undefined
      await scrollSettingsHome()
      return undefined
    }
    const settled = previous?.text === row.text && previous.bounds === row.bounds
    previous = row
    return settled ? row : undefined
  })
}

/** Force-stop and relaunch Settings so every case starts from its home page. */
async function openSettingsHome(): Promise<string> {
  await callTool("app_start", { packageName: `+${SETTINGS_PACKAGE}` })
  await waitFor("the Settings home page", PAGE_SETTLE_MS, async () =>
    (await settingsTitles()).length > 0 ? true : undefined
  )
  return foregroundActivity()
}

/**
 * Tap the first Settings row at the coordinates ui_find_element gives for it
 * and assert that the page it leads to is the one that opened.
 */
async function expectTapOpensFirstRow(): Promise<void> {
  const homeActivity = await openSettingsHome()
  const row = await firstSettingsRow()

  const tapped = await callTool("tap", { x: row.tapX, y: row.tapY })
  expect(tapped.isError, `tap failed: ${JSON.stringify(tapped.content)}`).toBeFalsy()

  const target = `"${row.text}" at (${row.tapX}, ${row.tapY})`
  const opened = await waitFor(
    `the tap on ${target} to leave the Settings home page`,
    PAGE_SETTLE_MS,
    async () => {
      const activity = await foregroundActivity()
      return activity !== homeActivity ? activity : undefined
    }
  )
  const title = parseResult(await callTool("ui_find_element", { text: row.text })) as FoundElements
  expect(title.count, `tap on ${target} opened ${opened}, which does not show that title`)
    .toBeGreaterThan(0)
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
