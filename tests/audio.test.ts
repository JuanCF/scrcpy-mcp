import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"
import * as net from "net"
import * as os from "os"
import * as fs from "fs"
import * as path from "path"
import {
  parseAudioHeader,
  buildServerArgs,
  receiveAudioHeader,
  receiveDeviceMeta,
  videoMetaLayout,
} from "../src/utils/scrcpy.js"
import {
  AUDIO_CODEC_ID_RAW,
  AUDIO_CODEC_ID_OPUS,
  AUDIO_CODEC_ID_AAC,
  AUDIO_CODEC_ID_FLAC,
  AUDIO_STREAM_DISABLED,
  AUDIO_STREAM_CONFIG_ERROR,
  AUDIO_SAMPLE_RATE,
} from "../src/utils/constants.js"
import {
  startAudioHub,
  attachAudioSink,
  detachAudioSink,
  listAudioSinks,
  stopAudioHub,
  onAudioHubStopped,
  pcmDurationSeconds,
  createRecordingSink,
  createClipSink,
  ffmpegHasLibopus,
  classifyFfmpegExit,
  type ClipSink,
} from "../src/utils/audio.js"
import {
  finaliseRecording,
  getAvailableBytes,
  recordingSinks,
  PCM_BYTES_PER_SECOND,
  type ActiveRecording,
} from "../src/tools/audio.js"
import { probeBinary } from "../src/utils/ffmpeg.js"

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
    socket = new EventEmitter() as unknown as net.Socket
    socket.resume = vi.fn()
    socket.off = socket.off.bind(socket)
    socket.on = socket.on.bind(socket)
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

  it("keeps the socket paused until the first sink attaches", () => {
    startAudioHub("test-device", socket)
    expect(socket.resume).not.toHaveBeenCalled()

    attachAudioSink("test-device", {
      id: "a",
      write: () => {},
      end: () => {},
    })
    expect(socket.resume).toHaveBeenCalledTimes(1)

    attachAudioSink("test-device", {
      id: "b",
      write: () => {},
      end: () => {},
    })
    expect(socket.resume).toHaveBeenCalledTimes(1)
  })

  it("flushes the header-overflow bytes into the first sink", () => {
    const initial = Buffer.from("first-pcm")
    const received: Buffer[] = []
    startAudioHub("test-device", socket, initial)
    expect(received).toEqual([])

    attachAudioSink("test-device", {
      id: "a",
      write: (chunk) => received.push(chunk),
      end: () => {},
    })
    expect(received).toEqual([initial])
  })

  it("notifies hub-stop listeners when the hub stops", () => {
    const listener = vi.fn()
    onAudioHubStopped(listener)
    startAudioHub("test-device", socket)

    stopAudioHub("test-device")
    expect(listener).toHaveBeenCalledWith("test-device")
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

describe("pcmDurationSeconds", () => {
  it("computes duration from raw PCM byte count", () => {
    // 48000 Hz, 2 channels, 2 bytes/sample -> 192000 bytes/sec
    expect(pcmDurationSeconds(192000)).toBe(1)
    expect(pcmDurationSeconds(96000)).toBe(0.5)
  })
})

describe("header reads leave the socket paused", () => {
  // Regression: receiveDeviceMeta/receiveAudioHeader used to resume the socket
  // and never pause it again. A flowing socket with no "data" listener discards
  // what arrives next, so with audio enabled the h264 config packet was lost
  // between the metadata read and startVideoStream — ffmpeg then never decoded
  // a frame and screenshots silently fell back to `adb screencap`.
  async function socketPair(): Promise<{
    client: net.Socket
    server: net.Socket
    close: () => void
  }> {
    const srv = net.createServer()
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
    const port = (srv.address() as net.AddressInfo).port
    const [client, server] = await Promise.all([
      new Promise<net.Socket>((resolve) => {
        const s = net.createConnection({ port, host: "127.0.0.1" }, () => resolve(s))
      }),
      new Promise<net.Socket>((resolve) => srv.once("connection", resolve)),
    ])
    return {
      client,
      server,
      close: () => {
        client.destroy()
        server.destroy()
        srv.close()
      },
    }
  }

  it("pauses the audio socket and keeps later bytes for the hub", async () => {
    const { client, server, close } = await socketPair()
    try {
      const header = Buffer.alloc(4)
      header.writeUInt32BE(AUDIO_CODEC_ID_RAW, 0)
      server.write(header)

      const result = await receiveAudioHeader(client, 0)
      expect(result.header).toEqual({ kind: "codec", codec: "raw" })
      expect(client.isPaused()).toBe(true)

      // Bytes sent while nothing is attached must survive until a consumer
      // resumes the socket, not be dropped on the floor.
      server.write(Buffer.from("pcm-payload"))
      await new Promise((resolve) => setTimeout(resolve, 50))

      const received = await new Promise<Buffer>((resolve) => {
        client.once("data", resolve)
        client.resume()
      })
      expect(received.toString()).toBe("pcm-payload")
    } finally {
      close()
    }
  })

  it("pauses the video socket and keeps the stream bytes that follow", async () => {
    const { client, server, close } = await socketPair()
    try {
      const layout = videoMetaLayout("3.3.4")
      const meta = Buffer.alloc(layout.metaSize)
      meta.write("test-device", 0, "utf8")
      meta.writeUInt32BE(480, layout.widthOffset)
      meta.writeUInt32BE(1024, layout.heightOffset)
      server.write(meta)

      const result = await receiveDeviceMeta(client, 0, layout)
      expect(result.width).toBe(480)
      expect(result.height).toBe(1024)
      expect(client.isPaused()).toBe(true)

      server.write(Buffer.from("h264-config"))
      await new Promise((resolve) => setTimeout(resolve, 50))

      const received = await new Promise<Buffer>((resolve) => {
        client.once("data", resolve)
        client.resume()
      })
      expect(received.toString()).toBe("h264-config")
    } finally {
      close()
    }
  })
})

describe("classifyFfmpegExit", () => {
  it("treats a clean exit as no failure", () => {
    expect(classifyFfmpegExit(0, null, false)).toBeNull()
  })

  it("reports a nonzero exit code", () => {
    expect(classifyFfmpegExit(1, null, false)).toMatch(/exited with code 1/)
  })

  // end() force-kills ffmpeg when it overruns the finalisation timeout; the
  // container is still written best-effort, and `killed` already reports it.
  it("accepts the SIGKILL that end() sends", () => {
    expect(classifyFfmpegExit(null, "SIGKILL", true)).toBeNull()
  })

  // Regression: the handler used to ignore every code === null exit, so an OOM
  // kill or a crash left failure unset and audio_record_stop reported a
  // truncated file as a good recording.
  it("reports a SIGKILL we did not send", () => {
    expect(classifyFfmpegExit(null, "SIGKILL", false)).toMatch(/terminated by SIGKILL/)
  })

  it("reports a crash signal even after a force-kill was requested", () => {
    expect(classifyFfmpegExit(null, "SIGSEGV", true)).toMatch(/terminated by SIGSEGV/)
  })

  it("reports an external SIGTERM", () => {
    expect(classifyFfmpegExit(null, "SIGTERM", false)).toMatch(/terminated by SIGTERM/)
  })
})

describe("createRecordingSink failure reporting", () => {
  const hasFfmpeg = probeBinary("ffmpeg") !== null

  // ffmpeg spawns fine and only fails later, so audio_record_start cannot see
  // the error; the sink has to keep it so audio_record_stop can report it.
  it("retains a nonzero ffmpeg exit", async () => {
    if (!hasFfmpeg) return

    const sink = createRecordingSink(
      "test-serial",
      "/nonexistent-scrcpy-mcp-dir/out.wav"
    )
    await sink.ready
    sink.write(Buffer.alloc(4096))
    sink.end()
    await sink.closed

    expect(sink.failure).toMatch(/ffmpeg/)
  })

  it("reports no failure for a clean run", async () => {
    if (!hasFfmpeg) return

    const outputPath = path.join(os.tmpdir(), `scrcpy-mcp-test-${Date.now()}.wav`)
    const sink = createRecordingSink("test-serial", outputPath)
    await sink.ready
    sink.write(Buffer.alloc(Math.round(AUDIO_SAMPLE_RATE * 2 * 2 * 0.1)))
    sink.end()
    await sink.closed

    expect(sink.failure).toBeNull()
    fs.rmSync(outputPath, { force: true })
  })
})

describe("createClipSink", () => {
  const hasFfmpeg = probeBinary("ffmpeg") !== null

  it("places the temp file under os.tmpdir()", () => {
    if (!hasFfmpeg) return

    const sink = createClipSink("test-serial", "wav")
    expect(path.dirname(sink.outputPath)).toBe(os.tmpdir())
    expect(sink.mimeType).toBe("audio/wav")
    // No data was written; just end so the process exits and we can clean up.
    sink.end()
  })

  it("defaults to opus/ogg when libopus is available", () => {
    if (!hasFfmpeg) return
    if (!ffmpegHasLibopus()) return

    const sink = createClipSink("test-serial")
    expect(sink.mimeType).toBe("audio/ogg")
    expect(sink.format).toBe("ogg")
    sink.end()
  })

  it("falls back to wav and reports the matching mimeType", () => {
    if (!hasFfmpeg) return

    const sink = createClipSink("test-serial", "wav")
    expect(sink.mimeType).toBe("audio/wav")
    expect(sink.format).toBe("wav")
    sink.end()
  })

  it("collect() reads and deletes the temp file on success", async () => {
    if (!hasFfmpeg) return

    const sink = createClipSink("test-serial", "wav")
    await sink.ready
    sink.write(Buffer.alloc(Math.round(AUDIO_SAMPLE_RATE * 2 * 2 * 0.1)))
    sink.end()

    const buf = await sink.collect()
    expect(buf.length).toBeGreaterThan(0)
    expect(fs.existsSync(sink.outputPath)).toBe(false)
  })

  it("collect() deletes the temp file when reading fails", async () => {
    if (!hasFfmpeg) return

    const sink = createClipSink("test-serial", "wav")
    await sink.ready
    sink.write(Buffer.alloc(Math.round(AUDIO_SAMPLE_RATE * 2 * 2 * 0.05)))
    sink.end()
    await sink.closed

    // Simulate a failure after finalisation by removing the file before collect.
    fs.rmSync(sink.outputPath, { force: true })

    await expect(sink.collect()).rejects.toThrow()
    expect(fs.existsSync(sink.outputPath)).toBe(false)
  })

  it("keeps the partial file readable after device loss (end) and deletes on collect", async () => {
    if (!hasFfmpeg) return

    const sink = createClipSink("test-serial", "wav")
    await sink.ready
    sink.write(Buffer.alloc(Math.round(AUDIO_SAMPLE_RATE * 2 * 2 * 0.1)))
    // Hub stop calls end() on every sink; simulate that here.
    sink.end()
    await sink.closed

    expect(fs.existsSync(sink.outputPath)).toBe(true)
    const buf = await sink.collect()
    expect(buf.length).toBeGreaterThan(0)
    expect(fs.existsSync(sink.outputPath)).toBe(false)
  })
})

describe("finaliseRecording", () => {
  let socket: net.Socket

  beforeEach(() => {
    recordingSinks.clear()
    socket = new EventEmitter() as unknown as net.Socket
    socket.resume = vi.fn()
    socket.off = socket.off.bind(socket)
    socket.on = socket.on.bind(socket)
  })

  afterEach(() => {
    stopAudioHub("race-device")
    stopAudioHub("hub-stop-device")
    recordingSinks.clear()
  })

  function fakeRecordingSink(): RecordingSink {
    return {
      id: "recording",
      outputPath: "/tmp/fake.wav",
      format: "wav",
      closed: Promise.resolve(),
      get killed() { return false },
      get pcmBytes() { return 0 },
      get failure() { return null },
      ready: Promise.resolve(),
      write: () => {},
      end: vi.fn(),
    } as unknown as RecordingSink
  }

  it("finalises exactly once when user stop races the maxDuration timer", () => {
    vi.useFakeTimers()
    try {
      const sink = fakeRecordingSink()
      startAudioHub("race-device", socket)
      attachAudioSink("race-device", sink)
      const rec: ActiveRecording = {
        sink,
        timer: setTimeout(() => finaliseRecording("race-device", "maxDuration"), 100),
        stoppedReason: "user",
        finalised: false,
      }
      recordingSinks.set("race-device", rec)

      finaliseRecording("race-device", "user")
      vi.advanceTimersByTime(200)

      expect(sink.end).toHaveBeenCalledTimes(1)
      expect(rec.stoppedReason).toBe("user")
      expect(rec.finalised).toBe(true)
      expect(rec.timer).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("sets deviceLost when the hub stops", () => {
    const sink = fakeRecordingSink()
    startAudioHub("hub-stop-device", socket)
    attachAudioSink("hub-stop-device", sink)
    const rec: ActiveRecording = {
      sink,
      timer: null,
      stoppedReason: "user",
      finalised: false,
    }
    recordingSinks.set("hub-stop-device", rec)

    finaliseRecording("hub-stop-device", "deviceLost")

    expect(rec.stoppedReason).toBe("deviceLost")
    expect(rec.finalised).toBe(true)
    expect(sink.end).toHaveBeenCalledOnce()
  })
})

describe("getAvailableBytes", () => {
  it("returns bavail × bsize from statfs", async () => {
    vi.spyOn(fs.promises, "statfs").mockResolvedValue({
      bavail: 100,
      bsize: 4096,
    } as fs.StatsFs)

    const bytes = await getAvailableBytes("/some/dir")
    expect(bytes).toBe(409600)
  })

  it("returns a large number when statfs fails", async () => {
    vi.spyOn(fs.promises, "statfs").mockRejectedValue(new Error("ENOENT"))

    const bytes = await getAvailableBytes("/nonexistent")
    expect(bytes).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe("recording size budget", () => {
  it("budgets maxDuration × 192000 bytes", () => {
    expect(PCM_BYTES_PER_SECOND).toBe(192000)
    expect(300 * PCM_BYTES_PER_SECOND).toBe(57600000)
  })
})

describe("onAudioHubStopped cleans up every sink type", () => {
  let socket: net.Socket

  beforeEach(() => {
    socket = new EventEmitter() as unknown as net.Socket
    socket.resume = vi.fn()
    socket.off = socket.off.bind(socket)
    socket.on = socket.on.bind(socket)
  })

  afterEach(() => {
    stopAudioHub("sink-cleanup-device")
    recordingSinks.clear()
  })

  it("finalises a recording sink with deviceLost", () => {
    const ended: string[] = []
    const sink = {
      id: "recording",
      write: () => {},
      end: () => { ended.push("recording") },
    }
    const rec: ActiveRecording = {
      sink: sink as unknown as RecordingSink,
      timer: null,
      stoppedReason: "user",
      finalised: false,
    }
    recordingSinks.set("sink-cleanup-device", rec)

    startAudioHub("sink-cleanup-device", socket)
    attachAudioSink("sink-cleanup-device", sink)
    stopAudioHub("sink-cleanup-device")

    expect(ended).toContain("recording")
    expect(rec.stoppedReason).toBe("deviceLost")
    expect(rec.finalised).toBe(true)
  })

  it("ends playback and clip sinks via the hub", () => {
    const ended: string[] = []
    const playback = { id: "playback", write: () => {}, end: () => { ended.push("playback") } }
    const clip = { id: "clip", write: () => {}, end: () => { ended.push("clip") } }

    startAudioHub("sink-cleanup-device", socket)
    attachAudioSink("sink-cleanup-device", playback)
    attachAudioSink("sink-cleanup-device", clip)
    stopAudioHub("sink-cleanup-device")

    expect(ended).toContain("playback")
    expect(ended).toContain("clip")
  })
})
