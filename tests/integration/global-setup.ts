import { execAdbShell, resolveSerial } from "../../src/utils/adb.js"

// The integration suite drives a real phone, so it must hand the device back in
// the state it found it. Anything that outlives a single test file is captured
// here rather than in per-file hooks: a file that crashes mid-run skips its own
// afterAll, but globalSetup's teardown still runs.

const SUITE_SCREEN_OFF_TIMEOUT = "600000"

let serial: string | null = null
let previousScreenOffTimeout: string | null = null

/** Run an adb shell command, swallowing failures so one broken step can't mask the rest. */
async function tryShell(command: string): Promise<void> {
  if (!serial) return
  try {
    await execAdbShell(serial, command)
  } catch {
    // best effort — teardown must keep going
  }
}

export async function setup(): Promise<void> {
  serial = await resolveSerial()

  // Keep the screen alive for the whole run; restored in teardown.
  const current = await execAdbShell(serial, "settings get system screen_off_timeout")
  const trimmed = current.trim()
  // `settings get` prints "null" for an unset key — nothing to restore in that case.
  previousScreenOffTimeout = trimmed && trimmed !== "null" ? trimmed : null

  await execAdbShell(
    serial,
    `settings put system screen_off_timeout ${SUITE_SCREEN_OFF_TIMEOUT}`
  )
}

export async function teardown(): Promise<void> {
  if (!serial) return

  if (previousScreenOffTimeout !== null) {
    await tryShell(`settings put system screen_off_timeout ${previousScreenOffTimeout}`)
  }

  // Leave the device awake and unlocked, whichever file happened to run last.
  await tryShell("input keyevent KEYCODE_WAKEUP")
  await tryShell("wm dismiss-keyguard")

  // Deliberately NOT restoring USB transport here. `adb usb` restarts adbd, and
  // on some devices it comes back unauthorized — requiring someone to physically
  // accept the USB-debugging dialog before any further run works. Only the Wi-Fi
  // tests switch the transport, and they are opt-in via TEST_WIFI=1, so that
  // undo lives in wifi.test.ts where it is actually needed.
}
