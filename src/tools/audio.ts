import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"
import { resolveSerial } from "../utils/adb.js"
import {
  getSession,
  startSession,
  stopSession,
  type ScrcpySession,
  type AudioSourceName,
} from "../utils/scrcpy.js"
import {
  startMjpegServer,
  startStreamViewer,
  stopMjpegServer,
  isMjpegServerRunning,
  getMjpegPort,
} from "../utils/mjpeg.js"
import {
  attachAudioSink,
  detachAudioSink,
  listAudioSinks,
  createPlaybackSink,
  createRecordingSink,
  createClipSink,
  defaultRecordingPath,
  onAudioHubStopped,
  pcmDurationSeconds,
  type RecordingSink,
  type PlaybackSink,
  type ClipSink,
} from "../utils/audio.js"
import { probeBinary } from "../utils/ffmpeg.js"

const playbackSinks = new Map<string, PlaybackSink>()
const clipSinks = new Map<string, ClipSink>()

export interface ActiveRecording {
  sink: RecordingSink
  timer: NodeJS.Timeout | null
  stoppedReason: "user" | "maxDuration" | "deviceLost"
  finalised: boolean
}

export const recordingSinks = new Map<string, ActiveRecording>()

/**
 * Finalise an active recording exactly once, whichever event arrives first:
 * user stop, maxDuration timer, or device loss. The entry stays in
 * recordingSinks so a late audio_record_stop can still report the outcome.
 */
export function finaliseRecording(
  serial: string,
  reason: "user" | "maxDuration" | "deviceLost"
): boolean {
  const rec = recordingSinks.get(serial)
  if (!rec || rec.finalised) return false
  rec.finalised = true
  rec.stoppedReason = reason
  if (rec.timer) {
    clearTimeout(rec.timer)
    rec.timer = null
  }
  detachAudioSink(serial, "recording")
  return true
}

// stopAudioHub (via stop_session or an audio-session restart) ends every
// attached sink; drop the tool-level entries with it so a later start tool
// doesn't report "already active" over a dead sink. For recordings, finalise
// the partial file with a deviceLost reason rather than discarding it.
onAudioHubStopped((serial) => {
  playbackSinks.delete(serial)
  clipSinks.delete(serial)
  finaliseRecording(serial, "deviceLost")
})

/**
 * Detect whether the installed MCP SDK advertises an `audio` content block.
 * The block has been in the MCP spec since the 2025-03-26 revision, but a
 * host pinned to an older SDK should be told why it is not getting the block.
 */
function mcpSdkSupportsAudioBlock(): { supported: boolean; version: string } {
  try {
    const require = createRequire(import.meta.url)
    const version = require("@modelcontextprotocol/sdk/package.json").version as string
    const major = Number.parseInt(version.split(".")[0] ?? "0", 10)
    return { supported: major >= 1 && !Number.isNaN(major), version }
  } catch {
    return { supported: false, version: "unknown" }
  }
}

async function ensureAudioSession(
  serial: string,
  options: { audioSource?: AudioSourceName; audioDup?: boolean } = {}
): Promise<{ session: ScrcpySession; sessionRestarted: boolean }> {
  const s = await resolveSerial(serial)
  const session = getSession(s)

  if (session && session.audioAvailable) {
    // Reuse only when the capture settings match — otherwise the tool would
    // report the requested source/muting state while the session keeps
    // streaming whatever it was started with.
    const sourceMatch =
      (session.options.audioSource ?? "output") === (options.audioSource ?? "output")
    const dupMatch =
      (session.options.audioDup ?? false) === (options.audioDup ?? false)
    if (sourceMatch && dupMatch) {
      return { session, sessionRestarted: false }
    }
  }

  const wasMjpegRunning = isMjpegServerRunning(s)
  const mjpegPort = getMjpegPort(s) ?? 7183
  const hadViewer = session?.viewerProcess ? true : false

  // Free the MJPEG port and viewer before tearing the session down.
  stopMjpegServer(s)
  await stopSession(s)

  // Restarting drops whatever the session was started with (frame size, and
  // the screen-awake settings that a long automation depends on), so carry
  // the previous options over and let the audio ones win.
  const newSession = await startSession(s, {
    ...session?.options,
    ...options,
    audio: true,
  })

  if (wasMjpegRunning) {
    const url = await startMjpegServer(s, mjpegPort)
    if (hadViewer) {
      await startStreamViewer(s, url)
    }
  }

  return { session: newSession, sessionRestarted: true }
}

function deviceMuted(audioSource: AudioSourceName, audioDup: boolean): boolean {
  // `output` (REMOTE_SUBMIX) reroutes device audio to the host, silencing the
  // speakers; `playback` without --audio-dup also leaves the device silent.
  // Microphone and voice-call sources don't touch device playback at all.
  return audioSource === "output" || (audioSource === "playback" && !audioDup)
}

/** Bytes per second of raw PCM: 48000 Hz × 2 channels × 2 bytes/sample. */
export const PCM_BYTES_PER_SECOND = 192000

export async function getAvailableBytes(dir: string): Promise<number> {
  try {
    const stat = await fs.promises.statfs(dir)
    return stat.bavail * stat.bsize
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

const audioSourceSchema = z.enum([
  "output",
  "playback",
  "mic",
  "mic-unprocessed",
  "mic-camcorder",
  "mic-voice-recognition",
  "mic-voice-communication",
  "voice-call",
  "voice-call-uplink",
  "voice-call-downlink",
  "voice-performance",
]).optional().default("output")

export function registerAudioTools(server: McpServer): void {
  server.registerTool(
    "audio_record_start",
    {
      description: "Start capturing device audio to a file on the host. Uses REMOTE_SUBMIX by default, which MUTES the device's own speakers while capturing. Use audioSource='playback' with audioDup=true (Android 13+) to keep the device audible. Requires Android 11+. Restarts the scrcpy session if it was started without audio. Recordings are automatically stopped after maxDuration seconds (default 300). Unlike screen_record_* this writes to the host filesystem directly.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        localPath: z.string().optional().describe("Host path for the recording (default ./scrcpy-mcp-audio-<timestamp>.wav)"),
        format: z.enum(["wav", "opus"]).optional().default("wav").describe("Recording format: wav (default) or opus"),
        maxDuration: z.number().int().positive().max(3600).optional().default(300).describe("Maximum recording duration in seconds (default 300)"),
        audioSource: audioSourceSchema.describe("Audio source"),
        audioDup: z.boolean().optional().default(false).describe("Keep device playback audible when using playback source (Android 13+)"),
      },
      outputSchema: {
        status: z.string().describe("Recording status"),
        localPath: z.string().describe("Host path the recording is being written to"),
        format: z.string().describe("Recording format"),
        maxDuration: z.number().describe("Maximum recording duration in seconds"),
        deviceMuted: z.boolean().describe("Whether the device's own speakers are muted"),
        sessionRestarted: z.boolean().describe("Whether the scrcpy session was restarted to enable audio"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: {
        title: "Start Audio Recording",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ serial, localPath, format, maxDuration, audioSource, audioDup }) => {
      try {
        if (!probeBinary("ffmpeg")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "ffmpeg was not found on the host. Install ffmpeg or set FFMPEG_PATH.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        const s = await resolveSerial(serial)
        const { session, sessionRestarted } = await ensureAudioSession(s, {
          audioSource,
          audioDup,
        })

        if (!session.audioAvailable) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "Audio capture is unavailable on this device (Android < 11 or capture failure).",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        if (listAudioSinks(s).includes("recording")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "An audio recording is already in progress for this device.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        const outputPath = localPath ?? defaultRecordingPath(format)
        const requiredBytes = maxDuration * PCM_BYTES_PER_SECOND
        const outputDir = path.resolve(path.dirname(outputPath))
        const availableBytes = await getAvailableBytes(outputDir)
        if (availableBytes < requiredBytes) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: `Not enough free space for a ${maxDuration}s recording: need ${requiredBytes} bytes, only ${availableBytes} bytes available on the target volume.`,
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        const sink = createRecordingSink(s, outputPath, format)
        try {
          await sink.ready
        } catch (err) {
          sink.end()
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: `ffmpeg failed to start: ${(err as Error).message}`,
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        if (!attachAudioSink(s, sink)) {
          sink.end()
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "The audio stream is not available for this device; the scrcpy audio hub is not running.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        const timer = setTimeout(() => {
          finaliseRecording(s, "maxDuration")
        }, maxDuration * 1000)

        recordingSinks.set(s, {
          sink,
          timer,
          stoppedReason: "user",
          finalised: false,
        })

        const structured = {
          status: "recording",
          localPath: outputPath,
          format,
          maxDuration,
          deviceMuted: deviceMuted(audioSource, audioDup),
          sessionRestarted,
          message: `Recording audio to ${outputPath} (${format}, max ${maxDuration}s). Device speakers are ${deviceMuted(audioSource, audioDup) ? "muted" : "audible"}.`,
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "error",
              message: `Failed to start audio recording: ${err.message}`,
            }, null, 2),
          }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    "audio_record_stop",
    {
      description: "Stop capturing device audio and finalise the file on the host. Returns the file path, size, and duration.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        status: z.string().describe("Recording status"),
        localPath: z.string().describe("Host path of the recording"),
        sizeBytes: z.number().describe("Final file size in bytes"),
        durationSeconds: z.number().describe("Estimated duration in seconds"),
        stoppedReason: z.enum(["user", "maxDuration", "deviceLost"]).describe("Why the recording stopped"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: {
        title: "Stop Audio Recording",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)
        const rec = recordingSinks.get(s)
        if (!rec) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "No audio recording is in progress for this device.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        finaliseRecording(s, "user")
        recordingSinks.delete(s)
        await rec.sink.closed

        const sink = rec.sink
        let sizeBytes = 0
        let statError: string | null = null
        try {
          const stat = await fs.promises.stat(sink.outputPath)
          sizeBytes = stat.size
        } catch (err) {
          statError = (err as Error).message
          console.error(`[audio] Could not stat recording ${sink.outputPath}:`, statError)
        }

        // ffmpeg only spawns synchronously at start time; a codec or output
        // failure surfaces later as a nonzero exit, so report it here rather
        // than claiming a recording that was never written.
        if (sink.failure || statError) {
          const reason = sink.failure ?? `output file is unreadable: ${statError}`
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                localPath: sink.outputPath,
                message: `Audio recording failed: ${reason}.`,
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        // Duration comes from the raw PCM bytes ffmpeg actually received —
        // reliable for both wav and opus, unlike the container size (which
        // for wav includes headers and for opus is a compressed bitstream).
        const durationSeconds = pcmDurationSeconds(sink.pcmBytes)
        const stoppedReason = rec.stoppedReason

        const reasonText = {
          user: "",
          maxDuration: " (stopped by maxDuration)",
          deviceLost: " (stopped because the device was lost)",
        }[stoppedReason]

        const structured = {
          status: "stopped",
          localPath: sink.outputPath,
          sizeBytes,
          durationSeconds,
          stoppedReason,
          message: `Recording saved to ${sink.outputPath} (${sizeBytes} bytes${sink.killed ? ", ffmpeg was force-killed" : ""})${reasonText}.`,
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "error",
              message: `Failed to stop audio recording: ${err.message}`,
            }, null, 2),
          }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    "start_audio_stream",
    {
      description: "Stream device audio to the host's speakers via ffplay. Uses REMOTE_SUBMIX by default, which MUTES the device's own speakers while streaming. Use audioSource='playback' with audioDup=true (Android 13+) to keep the device audible. Requires Android 11+. Restarts the scrcpy session if it was started without audio.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        audioSource: audioSourceSchema.describe("Audio source"),
        audioDup: z.boolean().optional().default(false).describe("Keep device playback audible when using playback source (Android 13+)"),
      },
      outputSchema: {
        status: z.string().describe("Stream status"),
        audioSource: z.string().describe("Audio source"),
        format: z.string().describe("Audio format"),
        deviceMuted: z.boolean().describe("Whether the device's own speakers are muted"),
        sessionRestarted: z.boolean().describe("Whether the scrcpy session was restarted to enable audio"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: {
        title: "Start Audio Stream",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ serial, audioSource, audioDup }) => {
      try {
        if (!probeBinary("ffplay")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "ffplay was not found on the host. Install ffmpeg (which includes ffplay) or set FFPLAY_PATH.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        const s = await resolveSerial(serial)
        const { session, sessionRestarted } = await ensureAudioSession(s, {
          audioSource,
          audioDup,
        })

        if (!session.audioAvailable) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "Audio capture is unavailable on this device (Android < 11 or capture failure).",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        if (listAudioSinks(s).includes("playback")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "An audio stream is already playing for this device.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        const sink = createPlaybackSink(s)
        try {
          await sink.ready
        } catch (err) {
          sink.end()
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: `ffplay failed to start: ${(err as Error).message}`,
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        if (!attachAudioSink(s, sink)) {
          sink.end()
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "The audio stream is not available for this device; the scrcpy audio hub is not running.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        playbackSinks.set(s, sink)

        const structured = {
          status: "playing",
          audioSource,
          format: "s16le 48000 Hz stereo",
          deviceMuted: deviceMuted(audioSource, audioDup),
          sessionRestarted,
          message: `Streaming audio from ${audioSource} to host speakers. Device speakers are ${deviceMuted(audioSource, audioDup) ? "muted" : "audible"}.`,
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "error",
              message: `Failed to start audio stream: ${err.message}`,
            }, null, 2),
          }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    "stop_audio_stream",
    {
      description: "Stop streaming device audio to the host's speakers.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        status: z.string().describe("Stream status"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: {
        title: "Stop Audio Stream",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)
        const sink = playbackSinks.get(s)
        if (!sink) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "No audio stream is playing for this device.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        playbackSinks.delete(s)
        detachAudioSink(s, "playback")
        const structured = { status: "stopped", message: "Audio stream stopped." }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "error",
              message: `Failed to stop audio stream: ${err.message}`,
            }, null, 2),
          }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    "audio_capture",
    {
      description: "Capture a bounded clip of device audio and return it as an audio content block. Uses REMOTE_SUBMIX by default, which MUTES the device's own speakers while capturing. Use audioSource='playback' with audioDup=true (Android 13+) to keep the device audible. Requires Android 11+. Restarts the scrcpy session if it was started without audio. Returns the audio to the caller as an audio content block — use audio_record_start to write a long capture to a file on the host instead.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        durationSeconds: z.number().int().positive().max(30).optional().describe("Capture duration in seconds (default 5; halved to 2.5 when libopus is unavailable and WAV fallback is used)"),
        audioSource: audioSourceSchema.describe("Audio source"),
        audioDup: z.boolean().optional().default(false).describe("Keep device playback audible when using playback source (Android 13+)"),
      },
      outputSchema: {
        status: z.string().describe("Capture status"),
        durationSeconds: z.number().describe("Actual captured duration in seconds"),
        sizeBytes: z.number().describe("Encoded clip size in bytes"),
        mimeType: z.string().describe("MIME type of the returned audio (audio/ogg or audio/wav)"),
        audioSource: z.string().describe("Audio source"),
        deviceMuted: z.boolean().describe("Whether the device's own speakers are muted"),
        sessionRestarted: z.boolean().describe("Whether the scrcpy session was restarted to enable audio"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: {
        title: "Capture Audio Clip",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ serial, durationSeconds, audioSource, audioDup }) => {
      let cleanupHubStop: (() => void) | null = null
      try {
        if (!probeBinary("ffmpeg")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "ffmpeg was not found on the host. Install ffmpeg or set FFMPEG_PATH.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        const s = await resolveSerial(serial)
        const { session, sessionRestarted } = await ensureAudioSession(s, {
          audioSource,
          audioDup,
        })

        if (!session.audioAvailable) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "Audio capture is unavailable on this device (Android < 11 or capture failure).",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        if (listAudioSinks(s).includes("clip")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "An audio capture is already in progress for this device.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        const sink = createClipSink(s)
        try {
          await sink.ready
        } catch (err) {
          sink.end()
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: `ffmpeg failed to start: ${(err as Error).message}`,
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        if (!attachAudioSink(s, sink)) {
          sink.end()
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: "The audio stream is not available for this device; the scrcpy audio hub is not running.",
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        clipSinks.set(s, sink)

        const requestedDuration = durationSeconds ?? 5
        const effectiveDuration = sink.mimeType === "audio/wav" && durationSeconds === undefined
          ? requestedDuration / 2
          : requestedDuration

        let hubStoppedEarly = false
        let resolveEarly: (() => void) | null = null
        const earlyStop = new Promise<void>((resolve) => {
          resolveEarly = resolve
        })
        cleanupHubStop = onAudioHubStopped((stoppedSerial) => {
          if (stoppedSerial === s) {
            hubStoppedEarly = true
            resolveEarly?.()
          }
        })

        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, effectiveDuration * 1000)),
          earlyStop,
        ])

        if (!hubStoppedEarly) {
          detachAudioSink(s, "clip")
        }
        clipSinks.delete(s)

        await sink.closed

        let fileBuffer: Buffer
        try {
          fileBuffer = await sink.collect()
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: `Failed to read captured audio clip: ${(err as Error).message}`,
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        if (sink.failure) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: `Audio capture failed: ${sink.failure}`,
              }, null, 2),
            }],
            isError: true as const,
          }
        }

        const base64 = fileBuffer.toString("base64")
        const structured = {
          status: "captured",
          durationSeconds: pcmDurationSeconds(sink.pcmBytes),
          sizeBytes: fileBuffer.length,
          mimeType: sink.mimeType,
          audioSource,
          deviceMuted: deviceMuted(audioSource, audioDup),
          sessionRestarted,
          message: `Captured ${effectiveDuration}s audio clip (${fileBuffer.length} bytes, ${sink.mimeType}).`,
        }

        const { supported: audioSupported, version: sdkVersion } = mcpSdkSupportsAudioBlock()
        if (!audioSupported) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ...structured,
                sdkVersion,
                warning: "Installed MCP SDK does not support audio content blocks; returning metadata only.",
              }, null, 2),
            }],
            structuredContent: structured,
            isError: true as const,
          }
        }

        return {
          content: [
            { type: "audio" as const, data: base64, mimeType: sink.mimeType },
            { type: "text" as const, text: JSON.stringify(structured, null, 2) },
          ],
          structuredContent: structured,
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "error",
              message: `Failed to capture audio: ${err.message}`,
            }, null, 2),
          }],
          isError: true as const,
        }
      } finally {
        cleanupHubStop?.()
      }
    }
  )
}
