import { execAdbShell, resolveSerial } from "../../src/utils/adb.js"

// The integration suite drives a real phone, so it must hand the device back in
// the state it found it. Anything that outlives a single test file is captured
// here rather than in per-file hooks: a file that crashes mid-run skips its own
// afterAll, but globalSetup's teardown still runs.

const SUITE_SCREEN_OFF_TIMEOUT = "600000"

let serial: string | null = null
let previousScreenOffTimeout: string | null = null
const cleanupFailures: { command: string; error: unknown }[] = []

/**
 * Run an adb shell command, deferring failures so one broken step can't skip the
 * ones after it. Every failure is still reported — see reportCleanupFailures().
 */
async function tryShell(command: string): Promise<void> {
  if (!serial) return
  try {
    await execAdbShell(serial, command)
  } catch (error) {
    cleanupFailures.push({ command, error })
  }
}

/**
 * Fail the run if teardown could not put the device back. Silently swallowing
 * these would let a green suite hand back a phone still pinned to the suite's
 * settings — the next run then starts from a state nobody chose.
 */
function reportCleanupFailures(): void {
  if (cleanupFailures.length === 0) return

  const summary = cleanupFailures
    .map(({ command, error }) => `  - ${command}: ${(error as Error).message}`)
    .join("\n")

  // Vitest prints a throw from globalSetup teardown as "error during close" but
  // still exits 0, so the throw alone would leave CI green. Setting the exit code
  // is what actually fails the run; the throw is what makes the cause readable.
  process.exitCode = 1
  throw new Error(
    `Integration teardown could not restore the device (${cleanupFailures.length} command(s) failed); it may be left in a modified state:\n${summary}`,
    {
      cause:
        cleanupFailures.length === 1
          ? cleanupFailures[0].error
          : new AggregateError(cleanupFailures.map(({ error }) => error)),
    }
  )
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
  } else {
    // The key was unset before the run, so writing SUITE_SCREEN_OFF_TIMEOUT
    // created it. Removing it is the actual restore — leaving it behind would
    // pin the device at a 10-minute timeout forever.
    await tryShell("settings delete system screen_off_timeout")
  }

  // Leave the display awake, whichever file happened to run last. The keyguard
  // is only best-effort: `wm dismiss-keyguard` exits 0 either way, but it is a
  // no-op against a *secure* keyguard (one with a PIN/pattern/password), which
  // it cannot dismiss without the user's credential — and should not. So on a
  // secured device the suite hands the phone back awake but locked. That is
  // fine: the suite is verified to pass from a locked start, since every file's
  // beforeAll wakes the screen and the tools it exercises work behind the lock.
  await tryShell("input keyevent KEYCODE_WAKEUP")
  await tryShell("wm dismiss-keyguard")

  // Deliberately NOT restoring USB transport here. `adb usb` restarts adbd, and
  // on some devices it comes back unauthorized — requiring someone to physically
  // accept the USB-debugging dialog before any further run works. Only the Wi-Fi
  // tests switch the transport, and they are opt-in via TEST_WIFI=1, so that
  // undo lives in wifi.test.ts where it is actually needed.

  reportCleanupFailures()
}
