import { spawn, ChildProcess } from "child_process"
import * as net from "net"
import * as path from "path"
import {
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_FORMAT,
  AUDIO_BYTES_PER_SAMPLE,
} from "./constants.js"
import { findFfmpeg, findFfplay } from "./ffmpeg.js"

export interface AudioSink {
  id: string
  write(chunk: Buffer): void
  end(): void
}

interface HubEntry {
  socket: net.Socket
  sinks: Map<string, AudioSink>
  // Bytes that arrived before the first sink attached (the audio header
  // overflow). Flushed into the first sink so a recording starts with the
  // very first PCM chunk instead of whatever happens to arrive next.
  pending: Buffer[]
  onData: (chunk: Buffer) => void
  onError: (err: Error) => void
  onClose: () => void
}

const hubs = new Map<string, HubEntry>()

const hubStopListeners = new Set<(serial: string) => void>()

export function onAudioHubStopped(listener: (serial: string) => void): void {
  hubStopListeners.add(listener)
}

export function startAudioHub(
  serial: string,
  socket: net.Socket,
  initial?: Buffer
): void {
  stopAudioHub(serial)

  const sinks = new Map<string, AudioSink>()

  const onData = (chunk: Buffer) => {
    if (sinks.size === 0) return
    for (const [id, sink] of sinks) {
      try {
        sink.write(chunk)
      } catch (err) {
        console.error(`[audio] Sink ${id} threw for ${serial}, detaching:`, err)
        sinks.delete(id)
      }
    }
  }

  const onError = (err: Error) => {
    console.error(`[audio] Socket error for ${serial}:`, err.message)
  }

  const onClose = () => {
    stopAudioHub(serial)
  }

  socket.on("data", onData)
  socket.on("error", onError)
  socket.on("close", onClose)

  const pending: Buffer[] = []
  if (initial && initial.length > 0) {
    pending.push(initial)
  }

  hubs.set(serial, { socket, sinks, pending, onData, onError, onClose })

  // The socket stays paused until the first sink attaches: while paused the
  // kernel buffers and TCP backpressure hold the stream, so no audio is lost
  // and nothing grows unboundedly on the host. attachAudioSink flushes the
  // pending bytes and resumes the flow.
}

export function attachAudioSink(serial: string, sink: AudioSink): boolean {
  const hub = hubs.get(serial)
  if (!hub) {
    console.error(`[audio] No audio hub for ${serial}; cannot attach sink ${sink.id}`)
    return false
  }
  const isFirst = hub.sinks.size === 0
  hub.sinks.set(sink.id, sink)
  if (isFirst) {
    for (const chunk of hub.pending) {
      hub.onData(chunk)
    }
    hub.pending = []
    hub.socket.resume()
  }
  return true
}

export function detachAudioSink(serial: string, id: string): boolean {
  const hub = hubs.get(serial)
  if (!hub) return false
  const sink = hub.sinks.get(id)
  if (!sink) return false
  hub.sinks.delete(id)
  try {
    sink.end()
  } catch (err) {
    console.error(`[audio] Sink ${id} end() threw for ${serial}:`, err)
  }
  return true
}

export function listAudioSinks(serial: string): string[] {
  return Array.from(hubs.get(serial)?.sinks.keys() ?? [])
}

export function stopAudioHub(serial: string): void {
  const hub = hubs.get(serial)
  if (!hub) return

  hub.socket.off("data", hub.onData)
  hub.socket.off("error", hub.onError)
  hub.socket.off("close", hub.onClose)

  for (const sink of hub.sinks.values()) {
    try {
      sink.end()
    } catch (err) {
      console.error(`[audio] Stopping sink ${sink.id} for ${serial} threw:`, err)
    }
  }
  hub.sinks.clear()
  hubs.delete(serial)

  // Tool-level bookkeeping (recordingSinks/playbackSinks in tools/audio.ts)
  // tracks sinks of its own; without this notification those maps would keep
  // stale entries for sinks the hub just ended.
  for (const listener of hubStopListeners) {
    try {
      listener(serial)
    } catch (err) {
      console.error(`[audio] Hub-stop listener threw for ${serial}:`, err)
    }
  }
}

export interface PlaybackSink extends AudioSink {
  process: ChildProcess
  /** Settles once ffplay has actually spawned; rejects if the spawn fails. */
  ready: Promise<void>
}

export function createPlaybackSink(serial: string): PlaybackSink {
  const proc = spawn(findFfplay(), [
    "-hide_banner",
    "-loglevel", "error",
    "-nodisp",
    "-autoexit",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-f", AUDIO_SAMPLE_FORMAT,
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-ac", String(AUDIO_CHANNELS),
    "-i", "pipe:0",
  ])

  // A failed spawn (binary vanished between probeBinary and here, EACCES, …)
  // emits "error" and never "exit"; without a listener that exception is
  // uncaught. ready lets the caller report the failure instead of success.
  const ready = new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => resolve())
    proc.once("error", reject)
  })
  proc.on("error", (err) => {
    console.error(`[audio] ffplay process error for ${serial}:`, err.message)
  })

  proc.stderr?.on("data", (data: Buffer) => {
    console.error(`[audio] ffplay stderr for ${serial}:`, data.toString().trim())
  })

  // ffplay exits non-zero when we kill it, which is what stopping the stream
  // does — only report an exit we did not ask for.
  let stopping = false

  proc.on("exit", (code) => {
    if (!stopping && code !== 0 && code !== null) {
      console.error(`[audio] ffplay exited with code ${code} for ${serial}`)
    }
  })

  const stdin = proc.stdin
  // A stalled ffplay makes stdin.write() return false; honouring that by
  // dropping audio until "drain" keeps a stuck child from growing the
  // in-process buffer without bound. The shared socket is never paused.
  let backpressured = false
  if (stdin) {
    stdin.on("drain", () => {
      backpressured = false
    })
    stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        console.error(`[audio] ffplay stdin EPIPE for ${serial}`)
      } else {
        console.error(`[audio] ffplay stdin error for ${serial}:`, err.message)
      }
    })
  }

  return {
    id: "playback",
    process: proc,
    ready,
    write: (chunk: Buffer) => {
      if (backpressured) return
      if (stdin && !stdin.destroyed) {
        try {
          if (!stdin.write(chunk)) {
            backpressured = true
            console.error(`[audio] ffplay stdin backpressured for ${serial}; dropping audio until drain`)
          }
        } catch { /* EPIPE handled above */ }
      }
    },
    end: () => {
      stopping = true
      if (stdin && !stdin.destroyed) {
        stdin.end()
      }
      if (proc && !proc.killed) {
        proc.kill()
      }
    },
  }
}

export interface RecordingSink extends AudioSink {
  outputPath: string
  format: "wav" | "opus"
  closed: Promise<void>
  killed: boolean
  /** Raw PCM bytes delivered to ffmpeg — the basis for the duration report. */
  pcmBytes: number
  /** Settles once ffmpeg has actually spawned; rejects if the spawn fails. */
  ready: Promise<void>
  /**
   * Terminal ffmpeg failure (process error, nonzero exit, or an unexpected
   * signal), or null when the encoder finished cleanly. The force-kill from
   * end() is not a failure — the container is still finalised on a best-effort
   * basis and `killed` reports it.
   */
  failure: string | null
}

/**
 * Describe an ffmpeg exit as a failure reason, or null when it finished
 * acceptably. A signal death reports code === null: the SIGKILL from end() is
 * expected — the container is finalised on a best-effort basis and `killed`
 * reports it — but any other signal (the OOM killer, SIGSEGV, an external
 * SIGTERM) leaves a truncated file that must not pass as a good recording.
 */
export function classifyFfmpegExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  forceKilled: boolean
): string | null {
  if (signal !== null) {
    return forceKilled && signal === "SIGKILL" ? null : `ffmpeg terminated by ${signal}`
  }
  return code !== null && code !== 0 ? `ffmpeg exited with code ${code}` : null
}

export function createRecordingSink(
  serial: string,
  outputPath: string,
  format: "wav" | "opus" = "wav"
): RecordingSink {
  const encoderArgs = format === "opus"
    ? ["-c:a", "libopus", "-b:a", "96k"]
    : ["-c:a", "pcm_s16le"]

  const proc = spawn(findFfmpeg(), [
    "-hide_banner",
    "-loglevel", "error",
    "-nostats",
    "-f", AUDIO_SAMPLE_FORMAT,
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-ac", String(AUDIO_CHANNELS),
    "-i", "pipe:0",
    ...encoderArgs,
    "-y", outputPath,
  ])

  let resolveClosed: (() => void) | null = null
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  let finalised = false
  let killed = false
  let pcmBytes = 0
  let failure: string | null = null

  const settleClosed = () => {
    if (!finalised) {
      finalised = true
      resolveClosed?.()
    }
  }

  // A failed spawn emits "error" and may never emit "exit"; settle closed so
  // audio_record_stop cannot hang waiting on a process that never ran, and
  // let ready reject so the start tool reports the failure.
  const ready = new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => resolve())
    proc.once("error", reject)
  })
  proc.on("error", (err) => {
    console.error(`[audio] ffmpeg process error for ${serial}:`, err.message)
    failure ??= `ffmpeg process error: ${err.message}`
    settleClosed()
  })

  proc.stderr?.on("data", (data: Buffer) => {
    console.error(`[audio] ffmpeg stderr for ${serial}:`, data.toString().trim())
  })

  proc.on("exit", (code, signal) => {
    const reason = classifyFfmpegExit(code, signal, killed)
    if (reason) {
      console.error(`[audio] ${reason} for ${serial}`)
      failure ??= reason
    }
    settleClosed()
  })

  const stdin = proc.stdin
  // Same backpressure contract as the playback sink: drop audio while the
  // child is stalled rather than buffering unboundedly, and never pause the
  // shared socket. Dropped chunks are not counted toward the duration.
  let backpressured = false
  if (stdin) {
    stdin.on("drain", () => {
      backpressured = false
    })
    stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        console.error(`[audio] ffmpeg stdin EPIPE for ${serial}`)
      } else {
        console.error(`[audio] ffmpeg stdin error for ${serial}:`, err.message)
      }
    })
  }

  return {
    id: "recording",
    outputPath,
    format,
    get killed() { return killed },
    get pcmBytes() { return pcmBytes },
    get failure() { return failure },
    closed,
    ready,
    write: (chunk: Buffer) => {
      if (backpressured) return
      if (stdin && !stdin.destroyed) {
        try {
          pcmBytes += chunk.length
          if (!stdin.write(chunk)) {
            backpressured = true
            console.error(`[audio] ffmpeg stdin backpressured for ${serial}; dropping audio until drain`)
          }
        } catch { /* EPIPE handled above */ }
      }
    },
    end: () => {
      if (finalised) return
      if (stdin && !stdin.destroyed) {
        stdin.end()
      }
      // Give ffmpeg up to 2 s to finalise the container, then force-kill.
      const killTimer = setTimeout(() => {
        if (!finalised && proc && !proc.killed) {
          killed = true
          proc.kill("SIGKILL")
        }
      }, 2000)
      proc.on("exit", () => {
        clearTimeout(killTimer)
      })
    },
  }
}

export function pcmDurationSeconds(pcmBytes: number): number {
  const bytesPerSecond = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE
  return bytesPerSecond === 0 ? 0 : pcmBytes / bytesPerSecond
}

export function defaultRecordingPath(format: "wav" | "opus" = "wav"): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  return path.join(process.cwd(), `scrcpy-mcp-audio-${timestamp}.${format}`)
}
