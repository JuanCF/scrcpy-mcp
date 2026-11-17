import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { orientToFrame, trackFrameSize } from "../src/utils/scrcpy.js"

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])
const PPS = Buffer.from("68ebe3cb22c0", "hex")
// SPS units taken from real libx264 streams; sizes confirmed with ffprobe.
const PORTRAIT_CONFIG = Buffer.concat([
  START_CODE,
  Buffer.from("6742c01fd900a0081b0110000003001000000303c0f1832480", "hex"),
  START_CODE,
  PPS,
])
const LANDSCAPE_CONFIG = Buffer.concat([
  START_CODE,
  Buffer.from("6764001facd94040051b0110000003001000000303c0f1831960", "hex"),
  START_CODE,
  PPS,
])

describe("orientToFrame", () => {
  it("keeps the native size when it already matches the frame's orientation", () => {
    const native = { width: 1440, height: 2560 }
    expect(orientToFrame(native, { width: 576, height: 1024 })).toEqual(native)
  })

  it("swaps a portrait-natural size for a landscape frame (issue #66)", () => {
    const native = orientToFrame({ width: 1600, height: 2560 }, { width: 1024, height: 640 })
    expect(native).toEqual({ width: 2560, height: 1600 })
    // One uniform factor again, so (2480, 147) maps to (992, 59) inside the frame.
    expect(1024 / native.width).toBe(640 / native.height)
  })

  it("swaps a landscape-natural size for a portrait frame", () => {
    expect(orientToFrame({ width: 2560, height: 1600 }, { width: 640, height: 1024 }))
      .toEqual({ width: 1600, height: 2560 })
  })

  it("leaves a square display and an unknown size alone", () => {
    expect(orientToFrame({ width: 1080, height: 1080 }, { width: 1024, height: 1024 }))
      .toEqual({ width: 1080, height: 1080 })
    expect(orientToFrame({ width: 0, height: 0 }, { width: 0, height: 0 }))
      .toEqual({ width: 0, height: 0 })
  })
})

describe("trackFrameSize", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function portraitSession() {
    return {
      serial: "test",
      screenSize: { width: 1600, height: 2560 },
      frameSize: { width: 640, height: 1024 },
    }
  }

  it("leaves the session alone while the stream keeps its size", () => {
    const session = portraitSession()
    const feed = trackFrameSize(session)
    feed(PORTRAIT_CONFIG)
    feed(PORTRAIT_CONFIG)
    expect(session.frameSize).toEqual({ width: 640, height: 1024 })
    expect(session.screenSize).toEqual({ width: 1600, height: 2560 })
  })

  it("keeps the size from the stream header when the first SPS disagrees", () => {
    const session = { ...portraitSession(), frameSize: { width: 648, height: 1024 } }
    trackFrameSize(session)(PORTRAIT_CONFIG)
    expect(session.frameSize).toEqual({ width: 648, height: 1024 })
  })

  it("follows a rotation to landscape and back", () => {
    const session = portraitSession()
    const feed = trackFrameSize(session)
    feed(PORTRAIT_CONFIG)

    feed(LANDSCAPE_CONFIG)
    expect(session.frameSize).toEqual({ width: 1024, height: 640 })
    expect(session.screenSize).toEqual({ width: 2560, height: 1600 })

    feed(PORTRAIT_CONFIG)
    expect(session.frameSize).toEqual({ width: 640, height: 1024 })
    expect(session.screenSize).toEqual({ width: 1600, height: 2560 })
  })

  it("follows a rotation that arrives split across socket reads", () => {
    const session = portraitSession()
    const feed = trackFrameSize(session)
    feed(PORTRAIT_CONFIG)
    feed(LANDSCAPE_CONFIG.subarray(0, 9))
    expect(session.frameSize).toEqual({ width: 640, height: 1024 })
    feed(LANDSCAPE_CONFIG.subarray(9))
    expect(session.frameSize).toEqual({ width: 1024, height: 640 })
  })
})
