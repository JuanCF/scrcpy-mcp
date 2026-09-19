import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"
import * as net from "net"
import {
  parseAudioHeader,
  buildServerArgs,
} from "../src/utils/scrcpy.js"
import {
  AUDIO_CODEC_ID_RAW,
  AUDIO_CODEC_ID_OPUS,
  AUDIO_CODEC_ID_AAC,
  AUDIO_CODEC_ID_FLAC,
  AUDIO_STREAM_DISABLED,
  AUDIO_STREAM_CONFIG_ERROR,
} from "../src/utils/constants.js"
import {
  startAudioHub,
  attachAudioSink,
  detachAudioSink,
  listAudioSinks,
  stopAudioHub,
  wavDurationSeconds,
} from "../src/utils/audio.js"

describe("parseAudioHeader", () => {
  function headerBytes(id: number): Buffer {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(id, 0)
    return buf
  }

  it("recognises raw codec", () => {
    expect(parseAudioHeader(headerBytes(AUDIO_CODEC_ID_RAW))).toEqual({
      kind: "codec",
      codec: "raw",
    })
  })

  it("recognises opus codec", () => {
    expect(parseAudioHeader(headerBytes(AUDIO_CODEC_ID_OPUS))).toEqual({
      kind: "codec",
      codec: "opus",
    })
  })

  it("recognises aac codec", () => {
    expect(parseAudioHeader(headerBytes(AUDIO_CODEC_ID_AAC))).toEqual({
      kind: "codec",
      codec: "aac",
    })
  })

  it("recognises flac codec", () => {
    expect(parseAudioHeader(headerBytes(AUDIO_CODEC_ID_FLAC))).toEqual({
      kind: "codec",
      codec: "flac",
    })
  })

  it("treats 0x00000000 as disabled", () => {
    expect(parseAudioHeader(headerBytes(AUDIO_STREAM_DISABLED))).toEqual({
      kind: "disabled",
    })
  })

  it("treats 0x00000001 as config error", () => {
    expect(parseAudioHeader(headerBytes(AUDIO_STREAM_CONFIG_ERROR))).toEqual({
      kind: "error",
    })
  })

  it("returns unknown for garbage input", () => {
    const result = parseAudioHeader(headerBytes(0xdeadbeef))
    expect(result).toEqual({ kind: "unknown", id: 0xdeadbeef })
  })

  it("returns unknown for a short buffer", () => {
    expect(parseAudioHeader(Buffer.from([0x00, 0x72]))).toEqual({
      kind: "unknown",
      id: -1,
    })
  })
})

describe("buildServerArgs audio args", () => {
  it.each(["3.3.4", "4.1"])(
    "omits audio options by default for version %s",
    (version) => {
      const args = buildServerArgs("SERIAL", 0x1234, version)
      expect(args).toContain("audio=false")
      expect(args).not.toContain("audio_codec=raw")
      expect(args).not.toContain("audio_source=output")
      expect(args).not.toContain("audio_dup=true")
    }
  )

  it.each(["3.3.4", "4.1"])(
    "adds raw audio args when audio=true for version %s",
    (version) => {
      const args = buildServerArgs("SERIAL", 0x1234, version, { audio: true })
      expect(args).toContain("audio=true")
      expect(args).toContain("audio_codec=raw")
      expect(args).toContain("audio_source=output")
      expect(args).not.toContain("audio_dup=true")
    }
  )

  it.each(["3.3.4", "4.1"])(
    "honours audioSource and audioDup for version %s",
    (version) => {
      const args = buildServerArgs("SERIAL", 0x1234, version, {
        audio: true,
        audioSource: "playback",
        audioDup: true,
      })
      expect(args).toContain("audio_source=playback")
      expect(args).toContain("audio_dup=true")
    }
  )
})

describe("AudioHub", () => {
  let socket: net.Socket

  beforeEach(() => {
    socket = new EventEmitter() as net.Socket
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(socket as any).resume = vi.fn()
    ;(socket as any).off = vi.fn()
    ;(socket as any).on = socket.on.bind(socket)
  })

  afterEach(() => {
    stopAudioHub("test-device")
  })

  it("fans chunks out to every attached sink", () => {
    const receivedA: Buffer[] = []
    const receivedB: Buffer[] = []
    startAudioHub("test-device", socket)
    attachAudioSink("test-device", {
      id: "a",
      write: (chunk) => receivedA.push(chunk),
      end: () => {},
    })
    attachAudioSink("test-device", {
      id: "b",
      write: (chunk) => receivedB.push(chunk),
      end: () => {},
    })

    const chunk = Buffer.from("pcm-data")
    socket.emit("data", chunk)

    expect(receivedA).toEqual([chunk])
    expect(receivedB).toEqual([chunk])
  })

  it("detaches a sink and stops delivering to it", () => {
    const received: Buffer[] = []
    startAudioHub("test-device", socket)
    attachAudioSink("test-device", {
      id: "target",
      write: (chunk) => received.push(chunk),
      end: () => {},
    })
    detachAudioSink("test-device", "target")

    socket.emit("data", Buffer.from("lost"))
    expect(received).toEqual([])
    expect(listAudioSinks("test-device")).toEqual([])
  })

  it("discards chunks when no sinks are attached", () => {
    startAudioHub("test-device", socket)
    expect(() => socket.emit("data", Buffer.from("orphan"))).not.toThrow()
    expect(listAudioSinks("test-device")).toEqual([])
  })

  it("detaches a throwing sink without disturbing others", () => {
    const received: Buffer[] = []
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    startAudioHub("test-device", socket)
    attachAudioSink("test-device", {
      id: "bad",
      write: () => {
        throw new Error("boom")
      },
      end: () => {},
    })
    attachAudioSink("test-device", {
      id: "good",
      write: (chunk) => received.push(chunk),
      end: () => {},
    })

    const chunk = Buffer.from("pcm-data")
    socket.emit("data", chunk)

    expect(received).toEqual([chunk])
    expect(listAudioSinks("test-device")).toEqual(["good"])
    consoleSpy.mockRestore()
  })

})

describe("wavDurationSeconds", () => {
  it("computes duration from byte count", () => {
    // 48000 Hz, 2 channels, 2 bytes/sample -> 192000 bytes/sec
    expect(wavDurationSeconds(192000)).toBe(1)
    expect(wavDurationSeconds(96000)).toBe(0.5)
  })
})
