import { describe, it, expect } from "vitest"
import {
  parseServiceCallParcel,
  parcelException,
  formatParcelException,
} from "../src/tools/clipboard.js"

// Verbatim output of `service call clipboard 2` on a Samsung SM-S918B
// (Android 16 / API 36) with a scrcpy session active and the clipboard set:
// the service still refuses the read because adb shell is not the foreground
// app. Truncated after the exception header, which is all the parser reads.
const refusedDump = `Result: Parcel(
0x00000000: fffffffd 00000008 006f004e 00690020 '........N.o. .i.'
0x00000010: 00650074 0073006d 00000000 000004ec 't.e.m.s.........'
0x00000020: 00000270 00610009 00200074 006f0063 'p.....a.t. .c.o.')`

describe("parseServiceCallParcel", () => {
  it("reads payload words and ignores the address labels", () => {
    const parcel = parseServiceCallParcel(refusedDump)

    expect(parcel).not.toBeNull()
    // 3 lines x 4 words x 4 bytes — the 0x........: labels contribute nothing.
    expect(parcel!.length).toBe(48)
    expect(parcel!.readInt32LE(0)).toBe(-3)
  })

  it("decodes words little-endian to match the ASCII gutter", () => {
    const parcel = parseServiceCallParcel(refusedDump)!

    // Words 006f004e 00690020 ... render as 'N.o. .i.' in the dump's gutter.
    expect(parcel.subarray(8, 24).toString("utf16le")).toBe("No items")
  })

  it("returns null when there is no parcel dump", () => {
    expect(parseServiceCallParcel("No shell command implementation.")).toBeNull()
    expect(parseServiceCallParcel("")).toBeNull()
  })
})

describe("parcelException", () => {
  // Regression: the old hex strategy matched the 0x00000000 address label and
  // decoded it into four NUL bytes, so clipboard_get answered a refused read
  // with the content "\0\0\0\0" and source "adb" instead of an error.
  it("reports the exception a refused read carries", () => {
    const parcel = parseServiceCallParcel(refusedDump)!

    expect(parcelException(parcel)).toEqual({ code: -3, message: "No items" })
  })

  it("returns null for a success parcel", () => {
    const parcel = Buffer.alloc(8)
    parcel.writeInt32LE(0, 0)

    expect(parcelException(parcel)).toBeNull()
  })

  it("reports the bare code when no message follows", () => {
    const parcel = Buffer.alloc(4)
    parcel.writeInt32LE(-3, 0)

    expect(parcelException(parcel)).toEqual({ code: -3, message: null })
  })
})

describe("formatParcelException", () => {
  it("renders the message and the code", () => {
    expect(formatParcelException({ code: -3, message: "No items" })).toBe("No items (code -3)")
  })

  it("renders the code alone when there is no message", () => {
    expect(formatParcelException({ code: -3, message: null })).toBe("code -3")
  })
})

describe("a permitted read", () => {
  // `service call clipboard 2` is IClipboard.getPrimaryClip, which returns a
  // nullable ClipData — a presence marker, then a ClipDescription (label, MIME
  // array, PersistableBundle, timestamp, version-dependent flags), then the
  // items. Reading offset 4 as a string length would decode that marker's "1"
  // as a one-character string and hand back the first two bytes of the
  // ClipDescription as clipboard text, so nothing is decoded off the parcel.
  it("carries no exception, so the tool does not report a refusal", () => {
    const clipData = Buffer.alloc(16)
    clipData.writeInt32LE(0, 0) // status: no exception
    clipData.writeInt32LE(1, 4) // ClipData present
    clipData.writeInt32LE(-1, 8) // ClipDescription label: null CharSequence

    expect(parcelException(clipData)).toBeNull()
  })
})
