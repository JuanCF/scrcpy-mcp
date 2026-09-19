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
  onData: (chunk: Buffer) => void
  onError: (err: Error) => void
  onClose: () => void
}

const hubs = new Map<string, HubEntry>()

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

  hubs.set(serial, { socket, sinks, onData, onError, onClose })

  if (initial && initial.length > 0) {
    onData(initial)
  }

  socket.resume()
}

export function attachAudioSink(serial: string, sink: AudioSink): boolean {
  const hub = hubs.get(serial)
  if (!hub) {
    console.error(`[audio] No audio hub for ${serial}; cannot attach sink ${sink.id}`)
    return false
  }
  hub.sinks.set(sink.id, sink)
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
}

export interface PlaybackSink extends AudioSink {
  process: ChildProcess
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
  if (stdin) {
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
    write: (chunk: Buffer) => {
      if (stdin && !stdin.destroyed) {
        try { stdin.write(chunk) } catch { /* EPIPE handled above */ }
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

  proc.stderr?.on("data", (data: Buffer) => {
    console.error(`[audio] ffmpeg stderr for ${serial}:`, data.toString().trim())
  })

  proc.on("exit", (code) => {
    if (!finalised) {
      finalised = true
      if (code !== 0 && code !== null) {
        console.error(`[audio] ffmpeg exited with code ${code} for ${serial}`)
      }
      resolveClosed?.()
    }
  })

  const stdin = proc.stdin
  if (stdin) {
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
    closed,
    write: (chunk: Buffer) => {
      if (stdin && !stdin.destroyed) {
        try { stdin.write(chunk) } catch { /* EPIPE handled above */ }
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

export function wavDurationSeconds(sizeBytes: number): number {
  const bytesPerSecond = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE
  return bytesPerSecond === 0 ? 0 : sizeBytes / bytesPerSecond
}

export function defaultRecordingPath(format: "wav" | "opus" = "wav"): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  return path.join(process.cwd(), `scrcpy-mcp-audio-${timestamp}.${format}`)
}
