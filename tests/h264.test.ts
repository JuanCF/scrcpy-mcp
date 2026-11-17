import { describe, it, expect } from "vitest"
import { parseSpsSize, createSpsScanner, FrameSize } from "../src/utils/h264.js"

// SPS units taken from real libx264 streams; sizes confirmed with ffprobe.
const SPS_BASELINE_640X1024 = Buffer.from(
  "6742c01fd900a0081b0110000003001000000303c0f1832480", "hex"
)
const SPS_HIGH_1024X640 = Buffer.from(
  "6764001facd94040051b0110000003001000000303c0f1831960", "hex"
)
// 376 is not a multiple of 16, so this one relies on the cropping fields.
const SPS_HIGH_376X800 = Buffer.from(
  "6764001eacd9418065e5f0110000030001000003003c0f162d96", "hex"
)
const PPS = Buffer.from("68ebe3cb22c0", "hex")
const IDR_SLICE = Buffer.from("65888400ffaabbccddeeff", "hex")
const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

function annexB(...nals: Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [START_CODE, nal]))
}

function scan(chunks: Buffer[]): FrameSize[] {
  const sizes: FrameSize[] = []
  const feed = createSpsScanner((size) => sizes.push(size))
  for (const chunk of chunks) feed(chunk)
  return sizes
}

describe("parseSpsSize", () => {
  it("reads a baseline-profile SPS", () => {
    expect(parseSpsSize(SPS_BASELINE_640X1024)).toEqual({ width: 640, height: 1024 })
  })

  it("reads a high-profile SPS", () => {
    expect(parseSpsSize(SPS_HIGH_1024X640)).toEqual({ width: 1024, height: 640 })
  })

  it("applies frame cropping", () => {
    expect(parseSpsSize(SPS_HIGH_376X800)).toEqual({ width: 376, height: 800 })
  })

  it("ignores bytes after the end of the SPS", () => {
    const padded = Buffer.concat([SPS_HIGH_1024X640, Buffer.from([0x00, 0xde, 0xad])])
    expect(parseSpsSize(padded)).toEqual({ width: 1024, height: 640 })
  })

  it("returns null for a NAL unit that is not an SPS", () => {
    expect(parseSpsSize(PPS)).toBeNull()
  })

  it("returns null when the forbidden zero bit is set", () => {
    const corrupt = Buffer.from(SPS_HIGH_1024X640)
    corrupt[0] |= 0x80
    expect(parseSpsSize(corrupt)).toBeNull()
  })

  it("returns null for a truncated SPS", () => {
    expect(parseSpsSize(SPS_HIGH_1024X640.subarray(0, 6))).toBeNull()
    expect(parseSpsSize(Buffer.alloc(0))).toBeNull()
  })
})

describe("createSpsScanner", () => {
  const stream = annexB(SPS_BASELINE_640X1024, PPS, IDR_SLICE)

  it("reports the SPS of a stream delivered in one chunk", () => {
    expect(scan([stream])).toEqual([{ width: 640, height: 1024 }])
  })

  it("reports the SPS once wherever the stream is split in two", () => {
    for (let split = 0; split <= stream.length; split++) {
      const sizes = scan([stream.subarray(0, split), stream.subarray(split)])
      expect(sizes, `split at ${split}`).toEqual([{ width: 640, height: 1024 }])
    }
  })

  it("reports the SPS once when the stream arrives a byte at a time", () => {
    const bytes = Array.from(stream, (byte) => Buffer.from([byte]))
    expect(scan(bytes)).toEqual([{ width: 640, height: 1024 }])
  })

  it("holds an SPS back until the next start code shows it is complete", () => {
    const sizes: FrameSize[] = []
    const feed = createSpsScanner((size) => sizes.push(size))
    feed(annexB(SPS_HIGH_1024X640))
    expect(sizes).toEqual([])
    feed(annexB(PPS))
    expect(sizes).toEqual([{ width: 1024, height: 640 }])
  })

  it("accepts three-byte start codes", () => {
    const shortCode = Buffer.from([0x00, 0x00, 0x01])
    const data = Buffer.concat([shortCode, SPS_HIGH_376X800, shortCode, PPS])
    expect(scan([data])).toEqual([{ width: 376, height: 800 }])
  })

  it("reports every SPS when the encoder restarts at a new size", () => {
    const rotated = Buffer.concat([
      stream,
      annexB(SPS_HIGH_1024X640, PPS, IDR_SLICE),
      annexB(SPS_BASELINE_640X1024, PPS, IDR_SLICE),
    ])
    expect(scan([rotated])).toEqual([
      { width: 640, height: 1024 },
      { width: 1024, height: 640 },
      { width: 640, height: 1024 },
    ])
  })

  it("is not thrown off by the session packet scrcpy 4 writes between encoders", () => {
    // flags (session bit), width 1024, height 640 — unframed when send_frame_meta=false
    const sessionPacket = Buffer.from("800000000000040000000280", "hex")
    const rotated = Buffer.concat([
      stream,
      sessionPacket,
      annexB(SPS_HIGH_1024X640, PPS, IDR_SLICE),
    ])
    for (let split = 0; split <= rotated.length; split++) {
      const sizes = scan([rotated.subarray(0, split), rotated.subarray(split)])
      expect(sizes, `split at ${split}`).toEqual([
        { width: 640, height: 1024 },
        { width: 1024, height: 640 },
      ])
    }
  })

  it("ignores a stream with no SPS", () => {
    expect(scan([annexB(PPS, IDR_SLICE), Buffer.alloc(0)])).toEqual([])
  })
})
