import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import * as fs from "fs"
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
  defaultRecordingPath,
  onAudioHubStopped,
  pcmDurationSeconds,
  type RecordingSink,
  type PlaybackSink,
} from "../utils/audio.js"
import { probeBinary } from "../utils/ffmpeg.js"

const playbackSinks = new Map<string, PlaybackSink>()
const recordingSinks = new Map<string, RecordingSink>()

// stopAudioHub (via stop_session or an audio-session restart) ends every
// attached sink; drop the tool-level entries with it so a later start tool
// doesn't report "already active" over a dead sink.
onAudioHubStopped((serial) => {
  playbackSinks.delete(serial)
  recordingSinks.delete(serial)
})

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
      description: "Start capturing device audio to a file on the host. Uses REMOTE_SUBMIX by default, which MUTES the device's own speakers while capturing. Use audioSource='playback' with audioDup=true (Android 13+) to keep the device audible. Requires Android 11+. Restarts the scrcpy session if it was started without audio. Unlike screen_record_* this writes to the host filesystem directly.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        localPath: z.string().optional().describe("Host path for the recording (default ./scrcpy-mcp-audio-<timestamp>.wav)"),
        format: z.enum(["wav", "opus"]).optional().default("wav").describe("Recording format: wav (default) or opus"),
        audioSource: audioSourceSchema.describe("Audio source"),
        audioDup: z.boolean().optional().default(false).describe("Keep device playback audible when using playback source (Android 13+)"),
      },
      outputSchema: {
        status: z.string().describe("Recording status"),
        localPath: z.string().describe("Host path the recording is being written to"),
        format: z.string().describe("Recording format"),
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
    async ({ serial, localPath, format, audioSource, audioDup }) => {
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

        if (recordingSinks.has(s) || listAudioSinks(s).includes("recording")) {
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
        recordingSinks.set(s, sink)

        const structured = {
          status: "recording",
          localPath: outputPath,
          format,
          deviceMuted: deviceMuted(audioSource, audioDup),
          sessionRestarted,
          message: `Recording audio to ${outputPath} (${format}). Device speakers are ${deviceMuted(audioSource, audioDup) ? "muted" : "audible"}.`,
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
        const sink = recordingSinks.get(s)
        if (!sink) {
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

        recordingSinks.delete(s)
        detachAudioSink(s, "recording")
        await sink.closed

        let sizeBytes = 0
        try {
          const stat = await fs.promises.stat(sink.outputPath)
          sizeBytes = stat.size
        } catch (err) {
          console.error(`[audio] Could not stat recording ${sink.outputPath}:`, (err as Error).message)
        }

        // Duration comes from the raw PCM bytes ffmpeg actually received —
        // reliable for both wav and opus, unlike the container size (which
        // for wav includes headers and for opus is a compressed bitstream).
        const durationSeconds = pcmDurationSeconds(sink.pcmBytes)

        const structured = {
          status: "stopped",
          localPath: sink.outputPath,
          sizeBytes,
          durationSeconds,
          message: `Recording saved to ${sink.outputPath} (${sizeBytes} bytes${sink.killed ? ", ffmpeg was force-killed" : ""}).`,
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

        if (playbackSinks.has(s) || listAudioSinks(s).includes("playback")) {
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
}
