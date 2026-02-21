export const ADB_PATH = process.env.ADB_PATH || "adb"

export const DEFAULT_TIMEOUT = 30000

export const SCRCPY_SERVER_PORT = 27183

export const SCRCPY_SERVER_PATH_LOCAL = "/data/local/tmp/scrcpy-server.jar"

export const SCRCPY_SERVER_VERSION = process.env.SCRCPY_SERVER_VERSION || "2.7"

/**
 * scrcpy Control Message Types
 *
 * These are the message type identifiers sent over the control socket to the
 * scrcpy server running on the Android device. Each control message starts
 * with a single byte indicating the message type, followed by type-specific
 * payload data.
 *
 * Reference: https://github.com/Genymobile/scrcpy/blob/master/app/src/control_msg.h
 */
export const CONTROL_MSG_TYPE_INJECT_KEYCODE = 0
export const CONTROL_MSG_TYPE_INJECT_TEXT = 1
export const CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT = 2
export const CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT = 3
export const CONTROL_MSG_TYPE_SET_DISPLAY_POWER = 4
export const CONTROL_MSG_TYPE_EXPAND_NOTIFICATION_PANEL = 5
export const CONTROL_MSG_TYPE_EXPAND_SETTINGS_PANEL = 6
export const CONTROL_MSG_TYPE_COLLAPSE_PANELS = 7
export const CONTROL_MSG_TYPE_GET_CLIPBOARD = 8
export const CONTROL_MSG_TYPE_SET_CLIPBOARD = 9
export const CONTROL_MSG_TYPE_ROTATE_DEVICE = 10
export const CONTROL_MSG_TYPE_START_APP = 16

export const DEVICE_MSG_TYPE_CLIPBOARD = 0

/**
 * Touch Event Actions
 *
 * Android MotionEvent action codes used in INJECT_TOUCH_EVENT messages.
 * These correspond to the standard Android touch event phases.
 *
 * - ACTION_DOWN: Finger/pointer has touched the screen
 * - ACTION_UP: Finger/pointer has lifted from the screen
 * - ACTION_MOVE: Finger/pointer is moving while touching the screen
 */
export const ACTION_DOWN = 0
export const ACTION_UP = 1
export const ACTION_MOVE = 2

/**
 * Display Power Modes
 *
 * Used with SET_DISPLAY_POWER to turn the screen on or off.
 * This is more reliable than using key events for screen control.
 */
export const DISPLAY_POWER_MODE_OFF = 0
export const DISPLAY_POWER_MODE_ON = 1

/**
 * Common Android Keycodes
 *
 * These are frequently used Android KeyEvent codes for INJECT_KEYCODE messages.
 * Full list: https://developer.android.com/reference/android/view/KeyEvent
 *
 * - KEYCODE_HOME (3): Home button - returns to launcher
 * - KEYCODE_BACK (4): Back button - navigates back
 * - KEYCODE_VOLUME_UP (24): Volume up
 * - KEYCODE_VOLUME_DOWN (25): Volume down
 * - KEYCODE_POWER (26): Power button - toggles screen on/off
 * - KEYCODE_ENTER (66): Enter/Return key
 * - KEYCODE_MENU (82): Menu button (legacy)
 */
export const KEYCODE_HOME = 3
export const KEYCODE_BACK = 4
export const KEYCODE_VOLUME_UP = 24
export const KEYCODE_VOLUME_DOWN = 25
export const KEYCODE_POWER = 26
export const KEYCODE_ENTER = 66
export const KEYCODE_MENU = 82

/**
 * Maximum text length for INJECT_TEXT messages
 *
 * scrcpy limits text injection to 300 bytes to prevent excessively large
 * messages on the control socket. For longer text, split into multiple calls.
 */
export const TEXT_MAX_LENGTH = 300

export const JPEG_SOI = 0xffd8
export const JPEG_EOI = 0xffd9

export const MAX_JPEG_BUFFER_SIZE = 10 * 1024 * 1024

export const MAX_CLIPBOARD_BYTES = 1024 * 1024
