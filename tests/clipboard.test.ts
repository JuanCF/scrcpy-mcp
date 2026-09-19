import { describe, it, expect } from "vitest"
import {
  parseServiceCallParcel,
  parcelExceptionMessage,
  parcelString,
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

describe("parcelExceptionMessage", () => {
  // Regression: the old hex strategy matched the 0x00000000 address label and
  // decoded it into four NUL bytes, so clipboard_get answered a refused read
  // with the content "\0\0\0\0" and source "adb" instead of an error.
  it("reports the exception a refused read carries", () => {
    const parcel = parseServiceCallParcel(refusedDump)!

    expect(parcelExceptionMessage(parcel)).toBe("No items (code -3)")
  })

  it("returns null for a success parcel", () => {
    const parcel = Buffer.alloc(8)
    parcel.writeInt32LE(0, 0)

    expect(parcelExceptionMessage(parcel)).toBeNull()
  })

  it("falls back to the bare code when no message follows", () => {
    const parcel = Buffer.alloc(4)
    parcel.writeInt32LE(-3, 0)

    expect(parcelExceptionMessage(parcel)).toBe("code -3")
  })
})

describe("parcelString", () => {
  it("decodes a length-prefixed UTF-16LE string after the status word", () => {
    const text = "clipboard-probe"
    const parcel = Buffer.alloc(8 + text.length * 2)
    parcel.writeInt32LE(0, 0)
    parcel.writeInt32LE(text.length, 4)
    parcel.write(text, 8, "utf16le")

    expect(parcelString(parcel)).toBe(text)
  })

  it("refuses to decode an exception parcel", () => {
    expect(parcelString(parseServiceCallParcel(refusedDump)!)).toBeNull()
  })

  it("refuses a length that overruns the parcel", () => {
    const parcel = Buffer.alloc(12)
    parcel.writeInt32LE(0, 0)
    parcel.writeInt32LE(99, 4)

    expect(parcelString(parcel)).toBeNull()
  })
})
