import { describe, it, expect } from "vitest"
import {
  serializeInjectKeycode,
  serializeInjectText,
  serializeInjectTouchEvent,
  serializeInjectScrollEvent,
  serializeSetDisplayPower,
  serializeExpandNotificationPanel,
  serializeExpandSettingsPanel,
  serializeCollapsePanels,
  serializeGetClipboard,
  serializeSetClipboard,
  serializeRotateDevice,
  serializeStartApp,
} from "../src/utils/scrcpy.js"

// Message type constants (from constants.ts)
const MSG_INJECT_KEYCODE = 0
const MSG_INJECT_TEXT = 1
const MSG_INJECT_TOUCH = 2
const MSG_INJECT_SCROLL = 3
const MSG_EXPAND_NOTIFICATIONS = 5
const MSG_EXPAND_SETTINGS = 6
const MSG_COLLAPSE_PANELS = 7
const MSG_GET_CLIPBOARD = 8
const MSG_SET_CLIPBOARD = 9
const MSG_SET_DISPLAY_POWER = 10
const MSG_ROTATE_DEVICE = 11
const MSG_START_APP = 16

describe("serializeInjectKeycode", () => {
  it("produces a 14-byte buffer", () => {
    expect(serializeInjectKeycode(0, 3).length).toBe(14)
  })

  it("sets message type byte to INJECT_KEYCODE (0)", () => {
    const buf = serializeInjectKeycode(0, 3)
    expect(buf.readUInt8(0)).toBe(MSG_INJECT_KEYCODE)
  })

  it("encodes action at byte 1", () => {
    const buf = serializeInjectKeycode(1, 3) // action=1 (UP)
    expect(buf.readUInt8(1)).toBe(1)
  })

  it("encodes keycode as int32BE at bytes 2-5", () => {
    const buf = serializeInjectKeycode(0, 66) // KEYCODE_ENTER
    expect(buf.readInt32BE(2)).toBe(66)
  })

  it("encodes repeat as int32BE at bytes 6-9", () => {
    const buf = serializeInjectKeycode(0, 66, 3)
    expect(buf.readInt32BE(6)).toBe(3)
  })

  it("encodes metaState as int32BE at bytes 10-13", () => {
    const buf = serializeInjectKeycode(0, 66, 0, 0x41) // shift + alt
    expect(buf.readInt32BE(10)).toBe(0x41)
  })

  it("defaults repeat and metaState to 0", () => {
    const buf = serializeInjectKeycode(0, 3)
    expect(buf.readInt32BE(6)).toBe(0)
    expect(buf.readInt32BE(10)).toBe(0)
  })
})

describe("serializeInjectText", () => {
  it("produces a buffer of 5 + text byte length", () => {
    const buf = serializeInjectText("hi")
    expect(buf.length).toBe(7) // 5 header + 2 chars
  })

  it("sets message type byte to INJECT_TEXT (1)", () => {
    expect(serializeInjectText("a").readUInt8(0)).toBe(MSG_INJECT_TEXT)
  })

  it("encodes text length as uint32BE at bytes 1-4", () => {
    const buf = serializeInjectText("hello")
    expect(buf.readUInt32BE(1)).toBe(5)
  })

  it("encodes text content starting at byte 5", () => {
    const buf = serializeInjectText("AB")
    expect(buf.readUInt8(5)).toBe(0x41) // 'A'
    expect(buf.readUInt8(6)).toBe(0x42) // 'B'
  })

  it("handles multi-byte UTF-8 characters", () => {
    const text = "é" // 2 UTF-8 bytes
    const buf = serializeInjectText(text)
    const textBytes = Buffer.from(text, "utf8")
    expect(buf.length).toBe(5 + textBytes.length)
    expect(buf.readUInt32BE(1)).toBe(textBytes.length)
  })

  it("throws when text exceeds 300 bytes", () => {
    const longText = "a".repeat(301)
    expect(() => serializeInjectText(longText)).toThrow("Text too long")
  })

  it("accepts text of exactly 300 bytes", () => {
    const maxText = "a".repeat(300)
    expect(() => serializeInjectText(maxText)).not.toThrow()
    expect(serializeInjectText(maxText).length).toBe(305)
  })
})

describe("serializeInjectTouchEvent", () => {
  const pointerId = BigInt("0xFFFFFFFFFFFFFFFF") // SC_POINTER_ID_MOUSE

  it("produces a 32-byte buffer", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 540, 1200, 1080, 2400, 1.0)
    expect(buf.length).toBe(32)
  })

  it("sets message type byte to INJECT_TOUCH_EVENT (2)", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 0, 0, 1080, 2400, 1.0)
    expect(buf.readUInt8(0)).toBe(MSG_INJECT_TOUCH)
  })

  it("encodes action at byte 1", () => {
    const buf = serializeInjectTouchEvent(1, pointerId, 0, 0, 1080, 2400, 0)
    expect(buf.readUInt8(1)).toBe(1) // ACTION_UP
  })

  it("encodes pointerId as uint64BE at bytes 2-9", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 0, 0, 1080, 2400, 1.0)
    expect(buf.readBigUInt64BE(2)).toBe(BigInt.asUintN(64, pointerId))
  })

  it("encodes x as int32BE at bytes 10-13", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 540, 1200, 1080, 2400, 1.0)
    expect(buf.readInt32BE(10)).toBe(540)
  })

  it("encodes y as int32BE at bytes 14-17", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 540, 1200, 1080, 2400, 1.0)
    expect(buf.readInt32BE(14)).toBe(1200)
  })

  it("encodes screenWidth as uint16BE at bytes 18-19", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 0, 0, 1080, 2400, 1.0)
    expect(buf.readUInt16BE(18)).toBe(1080)
  })

  it("encodes screenHeight as uint16BE at bytes 20-21", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 0, 0, 1080, 2400, 1.0)
    expect(buf.readUInt16BE(20)).toBe(2400)
  })

  it("encodes pressure=1.0 as 0xFFFF at bytes 22-23", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 0, 0, 1080, 2400, 1.0)
    expect(buf.readUInt16BE(22)).toBe(0xffff)
  })

  it("encodes pressure=0.0 as 0x0000 at bytes 22-23", () => {
    const buf = serializeInjectTouchEvent(1, pointerId, 0, 0, 1080, 2400, 0.0)
    expect(buf.readUInt16BE(22)).toBe(0x0000)
  })

  it("clamps pressure above 1.0 to 0xFFFF", () => {
    const buf = serializeInjectTouchEvent(0, pointerId, 0, 0, 1080, 2400, 2.0)
    expect(buf.readUInt16BE(22)).toBe(0xffff)
  })
})

describe("serializeInjectScrollEvent", () => {
  it("produces a 21-byte buffer", () => {
    expect(serializeInjectScrollEvent(540, 1200, 1080, 2400, 0, 3).length).toBe(21)
  })

  it("sets message type byte to INJECT_SCROLL_EVENT (3)", () => {
    expect(serializeInjectScrollEvent(0, 0, 1080, 2400, 0, 0).readUInt8(0)).toBe(MSG_INJECT_SCROLL)
  })

  it("encodes x at bytes 1-4 and y at bytes 5-8", () => {
    const buf = serializeInjectScrollEvent(540, 1200, 1080, 2400, 0, 0)
    expect(buf.readInt32BE(1)).toBe(540)
    expect(buf.readInt32BE(5)).toBe(1200)
  })

  it("encodes screenWidth at bytes 9-10 and screenHeight at bytes 11-12", () => {
    const buf = serializeInjectScrollEvent(0, 0, 1080, 2400, 0, 0)
    expect(buf.readUInt16BE(9)).toBe(1080)
    expect(buf.readUInt16BE(11)).toBe(2400)
  })

  it("encodes zero scroll as 0 in both axes", () => {
    const buf = serializeInjectScrollEvent(0, 0, 1080, 2400, 0, 0)
    expect(buf.readInt16BE(13)).toBe(0) // hScroll
    expect(buf.readInt16BE(15)).toBe(0) // vScroll
  })

  it("encodes max downward scroll (vScroll=16) as positive i16 max", () => {
    const buf = serializeInjectScrollEvent(0, 0, 1080, 2400, 0, 16)
    expect(buf.readInt16BE(15)).toBe(0x7fff)
  })

  it("encodes max upward scroll (vScroll=-16) as negative i16 min", () => {
    const buf = serializeInjectScrollEvent(0, 0, 1080, 2400, 0, -16)
    expect(buf.readInt16BE(15)).toBe(-0x8000)
  })

  it("encodes buttons as uint32BE at bytes 17-20", () => {
    const buf = serializeInjectScrollEvent(0, 0, 1080, 2400, 0, 0, 1)
    expect(buf.readUInt32BE(17)).toBe(1)
  })
})

describe("serializeSetDisplayPower", () => {
  it("produces a 2-byte buffer", () => {
    expect(serializeSetDisplayPower(true).length).toBe(2)
  })

  it("sets message type to SET_DISPLAY_POWER (10)", () => {
    expect(serializeSetDisplayPower(true).readUInt8(0)).toBe(MSG_SET_DISPLAY_POWER)
  })

  it("sets byte 1 to 1 when on=true", () => {
    expect(serializeSetDisplayPower(true).readUInt8(1)).toBe(1)
  })

  it("sets byte 1 to 0 when on=false", () => {
    expect(serializeSetDisplayPower(false).readUInt8(1)).toBe(0)
  })
})

describe("panel control serializers", () => {
  it("serializeExpandNotificationPanel returns [5]", () => {
    const buf = serializeExpandNotificationPanel()
    expect(buf.length).toBe(1)
    expect(buf.readUInt8(0)).toBe(MSG_EXPAND_NOTIFICATIONS)
  })

  it("serializeExpandSettingsPanel returns [6]", () => {
    const buf = serializeExpandSettingsPanel()
    expect(buf.length).toBe(1)
    expect(buf.readUInt8(0)).toBe(MSG_EXPAND_SETTINGS)
  })

  it("serializeCollapsePanels returns [7]", () => {
    const buf = serializeCollapsePanels()
    expect(buf.length).toBe(1)
    expect(buf.readUInt8(0)).toBe(MSG_COLLAPSE_PANELS)
  })

  it("serializeRotateDevice returns [11]", () => {
    const buf = serializeRotateDevice()
    expect(buf.length).toBe(1)
    expect(buf.readUInt8(0)).toBe(MSG_ROTATE_DEVICE)
  })
})

describe("serializeGetClipboard", () => {
  it("produces a 2-byte buffer", () => {
    expect(serializeGetClipboard().length).toBe(2)
  })

  it("sets message type to GET_CLIPBOARD (8)", () => {
    expect(serializeGetClipboard().readUInt8(0)).toBe(MSG_GET_CLIPBOARD)
  })

  it("defaults copyKey to 0 (NONE)", () => {
    expect(serializeGetClipboard().readUInt8(1)).toBe(0)
  })

  it("encodes provided copyKey at byte 1", () => {
    expect(serializeGetClipboard(1).readUInt8(1)).toBe(1) // COPY
    expect(serializeGetClipboard(2).readUInt8(1)).toBe(2) // CUT
  })
})

describe("serializeSetClipboard", () => {
  it("produces a buffer of 14 + text byte length", () => {
    const buf = serializeSetClipboard(1n, "hello")
    expect(buf.length).toBe(19) // 14 + 5
  })

  it("sets message type to SET_CLIPBOARD (9)", () => {
    expect(serializeSetClipboard(0n, "").readUInt8(0)).toBe(MSG_SET_CLIPBOARD)
  })

  it("encodes sequence as uint64BE at bytes 1-8", () => {
    const buf = serializeSetClipboard(42n, "")
    expect(buf.readBigUInt64BE(1)).toBe(42n)
  })

  it("encodes paste=false as 0 at byte 9", () => {
    expect(serializeSetClipboard(0n, "", false).readUInt8(9)).toBe(0)
  })

  it("encodes paste=true as 1 at byte 9", () => {
    expect(serializeSetClipboard(0n, "", true).readUInt8(9)).toBe(1)
  })

  it("encodes text length as uint32BE at bytes 10-13", () => {
    const buf = serializeSetClipboard(0n, "hello")
    expect(buf.readUInt32BE(10)).toBe(5)
  })

  it("encodes text content starting at byte 14", () => {
    const buf = serializeSetClipboard(0n, "AB")
    expect(buf.readUInt8(14)).toBe(0x41) // 'A'
    expect(buf.readUInt8(15)).toBe(0x42) // 'B'
  })
})

describe("serializeStartApp", () => {
  it("produces a buffer of 2 + package name byte length", () => {
    const buf = serializeStartApp("com.example.app")
    expect(buf.length).toBe(2 + "com.example.app".length)
  })

  it("sets message type to START_APP (16)", () => {
    expect(serializeStartApp("com.example.app").readUInt8(0)).toBe(MSG_START_APP)
  })

  it("encodes name length as uint8 at byte 1", () => {
    const name = "com.example.app"
    expect(serializeStartApp(name).readUInt8(1)).toBe(name.length)
  })

  it("encodes package name bytes starting at byte 2", () => {
    const buf = serializeStartApp("com.example.app")
    expect(buf.slice(2).toString("utf8")).toBe("com.example.app")
  })

  it("throws when package name exceeds 255 bytes", () => {
    const longName = "com." + "a".repeat(252)
    expect(() => serializeStartApp(longName)).toThrow("Package name too long")
  })

  it("accepts a package name of exactly 255 bytes", () => {
    const maxName = "com." + "a".repeat(251)
    expect(() => serializeStartApp(maxName)).not.toThrow()
  })
})
