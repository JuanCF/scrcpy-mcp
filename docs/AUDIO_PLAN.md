# Audio Streaming — Implementation Plan

> Adds device audio capture to scrcpy-mcp: local playback, recording to file,
> clips returned to the agent, and (optionally) a single synced audio+video
> viewer.

Companion to [PLAN.md](PLAN.md) and [ROADMAP.md](ROADMAP.md) (tracked as Phase 6.2).

---

## Table of Contents

1. [Scope & Deliverables](#1-scope--deliverables)
2. [Verified Protocol Facts](#2-verified-protocol-facts)
3. [Design Decisions](#3-design-decisions)
4. [Architecture: Current → Target](#4-architecture-current--target)
5. [Phase A — Transport Foundation](#5-phase-a--transport-foundation)
6. [Phase B — Local Playback](#6-phase-b--local-playback)
7. [Phase C — Recording to File](#7-phase-c--recording-to-file)
8. [Phase D — Frame-Meta Support](#8-phase-d--frame-meta-support)
9. [Phase E — Synced A/V Viewer](#9-phase-e--synced-av-viewer)
10. [Phase F — Agent-Facing Capture](#10-phase-f--agent-facing-capture)
11. [Phase G — Robustness & Limits](#11-phase-g--robustness--limits)
12. [Testing Strategy](#12-testing-strategy)
13. [Documentation Updates](#13-documentation-updates)
14. [Risks & Open Questions](#14-risks--open-questions)
15. [Task Checklist](#15-task-checklist)

---

## 1. Scope & Deliverables

Seven phases, each independently shippable. A–C deliver the feature and have
shipped; F and G close the gaps that shipping exposed; D–E are the expensive
follow-ups and remain explicitly optional.

| Phase | Deliverable | Depends on | Est. |
|-------|-------------|-----------|------|
| **A** | Audio socket plumbing — server args, 3-socket connect, header parse, fan-out hub | — | 3–4 h |
| **B** | `start_audio_stream` / `stop_audio_stream` — device audio out of the host speakers | A | 1–2 h |
| **C** | `audio_record_start` / `audio_record_stop` — capture to `.wav` / `.opus` on the host | A | 1–2 h |
| **D** | `send_frame_meta=true` support (12-byte packet headers, 3.x/4.x flag bits) | A | 2–3 h |
| **E** | Single synced audio+video viewer (replaces the silent MJPEG window) | D | 3–4 h |
| **F** | `audio_capture` — a bounded clip returned to the *agent* as an MCP audio content block | A | 2–3 h |
| **G** | Recording limits (`maxDuration`, size ceiling, free-space check) + mid-capture device loss | A | 2–3 h |

**Shipped:** A → C → B. See the [Task Checklist](#15-task-checklist) for what
remains outstanding from that delivery.

**Committed next: F, then G.** Both depend only on A, and neither waits on D or
E. F is the capability the project's own premise asks for — this server exists to
give an agent vision and control, and after A–C audio reaches the host's speakers
and the host's disk but never the agent. G bounds what C deliberately left
unbounded and handles the device vanishing mid-capture.

D and E stay deferred until the feature has been used in anger — see
[D6](#d6--build-order-recording-before-playback) and
[Deferred Decisions](#deferred-decisions). Phase letters stay as lettered above
throughout this document; only the build order differs.

**Non-goals:** injecting audio *into* the device; browser-based audio;
transcription (F hands the model the audio itself — what it does with it is the
model's business, not this server's).

---

## 2. Verified Protocol Facts

Read from the scrcpy server source at tags **v3.3.4** (pinned by
`SCRCPY_SERVER_VERSION`) and **v4.1** (latest release, 2026-07-12). Files:
`DesktopConnection.java`, `Streamer.java`, `Server.java`, `AudioRawRecorder.java`,
`AudioCodec.java`, `AudioConfig.java`, `Options.java`.

**The audio wire format is byte-identical in 3.x and 4.x.** The
`send_codec_meta` → `send_stream_meta` rename (already handled in
`buildServerArgs`) is the only version-dependent option, and it does not change
the audio header's shape.

| Fact | Detail |
|------|--------|
| Socket accept order (forward tunnel) | **video → audio → control**, strictly. With audio on, the client opens **three** connections to the forwarded port; audio must be **second**. |
| Dummy byte | First socket only (`getFirstSocket()`). With video on, the audio socket gets **none**. |
| Device meta (64-byte name) | First socket only. With video on, the audio socket gets **none** — it starts directly at its codec id. |
| Audio header | **4 bytes: the codec id**, nothing else (`writeAudioHeader`). Audio never carries width/height, and did **not** gain the 4-byte session-meta field video got in 4.0. No version branching needed. |
| Codec ids (big-endian ASCII) | `opus` `0x6f707573` · `aac` `0x00616163` · `flac` `0x666c6163` · `raw` `0x00726177` |
| Error sentinels (same 4 bytes) | `0x00000000` = capture unavailable, keep mirroring video · `0x00000001` = fatal config error, stop. Emitted on Android < 11 and on any capture failure (`writeDisableStream`). |
| `send_frame_meta` | **Global** — one flag for both streamers. `false` (current) ⇒ audio socket is a bare byte stream after the header. `true` ⇒ each packet prefixed by 12 bytes (8-byte pts+flags, 4-byte size). |
| Frame-meta flag bits **moved in 4.0** | 3.x: `CONFIG=1<<63`, `KEY_FRAME=1<<62`. 4.x: `SESSION=1<<63`, `CONFIG=1<<62`, `KEY_FRAME=1<<61`. |
| Raw PCM format | **S16LE, 48000 Hz, stereo** (`AudioConfig`). ~192 KB/s. |
| Android requirement | **11+**. 12+ works unattended; 11 needs the screen unlocked when the session starts. |
| Server option keys | Identical in both tags: `audio`, `audio_codec`, `audio_source`, `audio_bit_rate`, `audio_dup`, `audio_encoder`, `audio_codec_options`. |
| Audio sources | `output` (REMOTE_SUBMIX, default) · `playback` (A13+) · `mic` · `mic-unprocessed` · `mic-camcorder` · `mic-voice-recognition` · `mic-voice-communication` · `voice-call[-uplink|-downlink]` · `voice-performance` |

---

## 3. Design Decisions

### Decisions Log

| Decision | Choice | Detail |
|----------|--------|--------|
| Scope | A + C + B shipped; F + G next; D + E deferred | [§1](#1-scope--deliverables) |
| Build order | A → C → B | [D6](#d6--build-order-recording-before-playback) |
| Default audio source | `output` — captures everything, mutes the device | [D1](#d1--audio-is-opt-in-never-on-by-default) |
| `audio` in `start_session` | never defaults to `true` | [D1](#d1--audio-is-opt-in-never-on-by-default) |
| Audio codec, phases A–C | `raw` only | [D2](#d2--raw-pcm-only-until-phase-d) |
| Enabling audio on a live session | auto-restart, report `sessionRestarted` | [D3](#d3--enabling-audio-restarts-the-session-automatically) |
| Buffering with no consumer | discard, never buffer | [D4](#d4--one-reader-many-sinks-audiohub) |
| A/V sync in Phase B | none; accepted | [D5](#d5--phase-b-has-no-av-sync-and-thats-acceptable) |
| Tool naming | mirror each neighbour; rename nothing | [D7](#d7--tool-names-mirror-their-neighbours) |
| Where recordings land | the host filesystem | [D8](#d8--recording-is-host-side-wav-by-default) |
| Default recording format | `.wav`; opus opt-in | [D8](#d8--recording-is-host-side-wav-by-default) |
| Getting audio to the agent | a bounded clip, not a stream | [D9](#d9--the-agent-gets-a-clip-not-a-stream) |
| Unbounded captures | every capture gets a ceiling | [D10](#d10--every-capture-is-bounded) |

### D1 — Audio is opt-in, never on by default

The default source `output` maps to `REMOTE_SUBMIX`, which per scrcpy's docs
"forwards the whole audio output, **and disables playback on the device**." Audio
is *moved* to the host, not copied — the phone goes silent for as long as capture
runs. Enabling that implicitly on every `start_session` would be a nasty
surprise, so:

- `start_session` gains `audio?: boolean` defaulting to **`false`** (current behaviour).
- Every audio tool description states the muting behaviour explicitly.
- `audioSource: "playback"` + `audioDup: true` (Android 13+) is the documented
  escape hatch for keeping the phone audible.

**Why `output` stays the default** despite the muting: `playback` is Android 13+
only, and apps can opt out of being captured — so it can silently yield nothing,
or a partial mix, with no error to point at. A surprising silence on the device is
a better failure than surprising missing audio in the capture. `output` also covers
the whole supported range: Android 11 and 12 devices can use nothing else.

Before any manual testing, check the test device actually clears the floor —
`adb shell getprop ro.build.version.sdk` must be **≥ 30**. Below that there is no
audio at any source, and the header sentinel path (A.6) is all you can exercise.

### D2 — Raw PCM only until Phase D

With `send_frame_meta=false` there are no packet boundaries, so opus/aac/flac
streams are undecodable — the config/extradata packet can't be separated
(`fixOpusConfigPacket` exists precisely because that's fiddly). Raw PCM needs no
framing at all.

⇒ Phases A–C hard-restrict `audioCodec` to `raw` and reject anything else with a
clear error pointing at Phase D. This keeps the whole first delivery free of
version-dependent bits.

### D3 — Enabling audio restarts the session automatically

scrcpy server options are fixed at process start; you cannot add an audio socket
to a running server. So `start_audio_stream` on a session started without audio
must stop and restart it. The restart is ~1–2 s and drops the control socket and
video stream, so it must be explicit in the tool response, and the MJPEG server +
viewer must be restored afterwards on the same port (see A.7).

**Chosen: restart automatically**, reporting `sessionRestarted: true`. Two
alternatives were considered and rejected:

- *Refuse, and require the caller to restart with `audio: true`* — honest, but
  turns a one-call operation into three and leaves the caller to reconstruct the
  session options they originally used.
- *Require `force: true` to restart* — the same friction, plus a flag whose
  meaning is unguessable the first time you hit it.

The residual risk is a silent restart in the middle of a long automation run
(R2). It is mitigated by the flag in the response rather than by refusing, on the
grounds that a caller who asked for audio has asked for the only thing that
delivers it.

### D4 — One reader, many sinks (`AudioHub`)

Mirrors the proven MJPEG design (one encoder on the device, many consumers on the
host). A single reader owns the audio socket and fans chunks out to registered
sinks; playback, recording, and the future mux are all just sinks.

**Critical:** with no sinks attached, chunks are **discarded, never buffered**.
Audio arrives at 192 KB/s continuously; buffering it would grow without bound,
and letting TCP backpressure build would make audio badly stale the moment a sink
attaches.

### D5 — Phase B has no A/V sync, and that's acceptable

Playback runs as its own `ffplay` process, fully independent of the video path.
Video and audio each drift on their own. Both are low-latency (~100 ms), so it's
fine for automation and demos; genuine lip-sync is Phase E's job.

### D6 — Build order: recording before playback

Phases B and C are independent once A lands, so the order is a free choice.
**Recording (C) ships first.** This server's consumer is an AI agent — the
project's stated purpose is giving agents vision and control — and a `.wav` on
disk is something an agent can actually process, hand onward, or transcribe.
Playback (B) is mostly valuable to a human watching a demo, which is a smaller
and less frequent audience.

Phase letters are kept as originally lettered (B = playback, C = recording)
throughout this document to avoid churn; only the build order is A → C → B.

### D7 — Tool names mirror their neighbours

The existing tools split conventions: `start_video_stream` is verb-first,
`screen_record_start` is noun-first. The audio tools mirror each local neighbour
rather than imposing one scheme:

| New tool | Mirrors |
|----------|---------|
| `start_audio_stream` / `stop_audio_stream` | `start_video_stream` / `stop_video_stream` |
| `audio_record_start` / `audio_record_stop` | `screen_record_start` / `screen_record_stop` |

This knowingly perpetuates the inconsistency. The alternative — one scheme for all
four audio tools — would make the audio tools internally tidy but inconsistent
with the video tool sitting next to each of them, and renaming the four existing
tools to fix it properly is a breaking change to every client's tool list. Local
consistency wins; revisit only at a major version.

### D8 — Recording is host-side, WAV by default

**Host-side.** Unlike `screen_record_*`, which records **on the device** and
optionally pulls, audio records straight to the host filesystem — the PCM bytes
are already on the host, so round-tripping them through `/sdcard` and back would
be pure overhead. The asymmetry is deliberate and must be stated in the tool
descriptions so it doesn't read as an oversight.

**WAV by default.** `pcm_s16le` is a straight container write with no re-encode
and no codec dependency, at ~11 MB/min. Opus is ~0.7 MB/min but needs libopus
compiled into the host's ffmpeg, which is not guaranteed and fails at record time
rather than at validation time. Fidelity and reliability beat file size for a
capture that is typically seconds to minutes long; `format: "opus"` is available
for anyone who wants it.

### D9 — The agent gets a clip, not a stream

Phases B and C both end on the host: the speakers, or a file. Neither puts audio
where this server's actual consumer can reach it. `screenshot` hands the model a
base64 `image` block; there is no equivalent for sound, so an agent can capture
audio and still not hear it. The ROADMAP's "transcribe device audio from a
captured `.wav`" idea is a workaround for that gap, not a feature in its own
right.

MCP's content model has carried an `audio` block since the 2025-03-26 revision,
shaped exactly like `image` (`data` + `mimeType`). Phase F uses it: attach a sink
for `durationSeconds`, encode, return the bytes inline.

**Chosen: a bounded clip, not a stream.** A tool call is request/response — there
is no way to hand a model a continuous feed, and no reason to want one, since it
consumes a fixed clip in a single turn. The rejected alternative was *make
`audio_record_stop` return the file inline too*: it conflates two jobs, since
recording is deliberately host-side (D8) and recordings run to minutes and
megabytes.

Two consequences the implementation must respect:

- **Encode; never ship raw PCM inline.** Ten seconds of S16LE/48k/stereo is
  1.9 MB, which is ~2.6 MB of base64 in the context window. Opus in an ogg
  container is ~0.1 MB for the same ten seconds.
- **The call blocks for its whole duration.** A hard cap in the schema is what
  keeps that honest (R10).

### D10 — Every capture is bounded

`screen_record_start` takes `maxDuration` and the device enforces it (~180 s).
`audio_record_start` takes nothing: the hub writes 192 KB/s to the host until
someone calls `audio_record_stop`. An agent that forgets the stop call — or dies
between the two — leaves ffmpeg writing ~11 MB/min until the disk fills. R4
covers ADB bandwidth; nothing covered host disk.

⇒ Phase G gives every capture a ceiling: a `maxDuration` default of 300 s, a size
budget derived from it, and a free-space check before ffmpeg is spawned. Hitting
a ceiling **finalises the file cleanly** and reports
`stoppedReason: "maxDuration"` — the caller gets the same bytes they would have
got, just with an end on them.

### Deferred Decisions

Recorded so the triggers are explicit rather than rediscovered later:

| Deferred | Current position | Revisit when |
|----------|------------------|--------------|
| `audio: true` as a `start_session` default | Never defaults true (D1) | Only if callers end up passing it every single time — and even then the muting (R1) probably still forbids it |
| Phase D (frame meta + compressed codecs) | Deferred | Wi-Fi ADB becomes a common setup — 192 KB/s of raw PCM over TCP is the pain point that promotes it |
| Phase E (synced A/V viewer) | Deferred, depends on D | Someone actually needs lip-sync; until then the silent MJPEG window plus separate audio is sufficient |
| Renaming tools to one naming scheme | Not doing it (D7) | A major version bump, where breaking the tool list is already on the table |

---

## 4. Architecture: Current → Target

**Current** — the viewer is silent by construction: MJPEG-over-multipart is a
bare sequence of `Content-Type: image/jpeg` parts with no stream table and no
place to put an audio track.

```
device ──h264──▶ videoSocket ──▶ [Node] ──▶ ffmpeg (h264→mjpeg) ──▶ session.frameBuffer
                                                                        │
                                                    ┌───────────────────┴─────────┐
                                              screenshot tool          MJPEG HTTP :7183
                                                                              │
                                                                        ffplay (silent)
```

**Target after Phases B/C, plus F** — audio is a second, parallel pipeline; the
hub fans one socket out to the host's speakers, the host's disk, and the agent:

```
device ──h264───▶ videoSocket ──▶ [Node] ──▶ ffmpeg ──▶ frameBuffer ──▶ MJPEG :7183 ──▶ ffplay (silent)
       ──pcm────▶ audioSocket ──▶ [AudioHub] ──┬──▶ ffplay -nodisp        (host speakers)
                                               ├──▶ ffmpeg ──▶ capture.wav / .opus
                                               └──▶ ffmpeg ──▶ clip.ogg ──▶ base64 ▶ MCP audio block   (Phase F)
       ◀─control─ controlSocket
```

**Target after Phase E** — the h264 bytes already pass through Node
(`videoSocket.on("data") → ffmpeg.stdin.write`, `src/utils/scrcpy.ts:498`), so
teeing them to a second consumer is trivial:

```
                        ┌──▶ ffmpeg (h264→mjpeg) ──▶ frameBuffer ──▶ MJPEG :7183 (screenshots)
h264 ──▶ [Node tee] ────┤
                        └──▶ ffmpeg mux ◀── pcm ──▶ MPEG-TS over HTTP ──▶ ffplay (synced A/V)
```

---

## 5. Phase A — Transport Foundation

### A.1 Constants (`src/utils/constants.ts`)

Append a documented block in the existing style:

```ts
/**
 * scrcpy audio socket. Identical in 3.x and 4.x: the header is 4 bytes holding
 * the codec id and nothing else — audio never carries width/height, and did not
 * gain the session-meta field video got in 4.0. The dummy byte and the 64-byte
 * device name go to the FIRST socket only, which is the video socket whenever
 * video is enabled, so the audio socket starts directly at this header.
 */
export const AUDIO_HEADER_SIZE = 4

export const AUDIO_CODEC_ID_RAW = 0x00726177
export const AUDIO_CODEC_ID_OPUS = 0x6f707573
export const AUDIO_CODEC_ID_AAC = 0x00616163
export const AUDIO_CODEC_ID_FLAC = 0x666c6163

/** Sentinels the server writes in place of a codec id (writeDisableStream). */
export const AUDIO_STREAM_DISABLED = 0x00000000
export const AUDIO_STREAM_CONFIG_ERROR = 0x00000001

/** Raw capture format, fixed by the server's AudioConfig. */
export const AUDIO_SAMPLE_RATE = 48000
export const AUDIO_CHANNELS = 2
export const AUDIO_SAMPLE_FORMAT = "s16le"
export const AUDIO_BYTES_PER_SAMPLE = 2

export const AUDIO_HEADER_TIMEOUT_MS = 5000
```

### A.2 Session types (`src/utils/scrcpy.ts:264`)

```ts
export type AudioSourceName =
  | "output" | "playback" | "mic" | "mic-unprocessed" | "mic-camcorder"
  | "mic-voice-recognition" | "mic-voice-communication"
  | "voice-call" | "voice-call-uplink" | "voice-call-downlink"
  | "voice-performance"

export interface ScrcpySessionOptions {
  maxSize?: number
  maxFps?: number
  videoBitRate?: number
  /** Opt-in: `output` (the default source) MUTES the device while capturing. */
  audio?: boolean
  audioSource?: AudioSourceName
  /** Keep device playback audible with `playback`. Android 13+ only. */
  audioDup?: boolean
}
```

On `ScrcpySession` add, alongside `videoSocket` / `videoAvailable`:

```ts
audioSocket: net.Socket | null
/** False when audio was requested but the device refused it (Android < 11,
 *  capture failure, or header timeout). The session stays fully usable. */
audioAvailable: boolean
audioCodec: "raw" | null
```

### A.3 `buildServerArgs` (`src/utils/scrcpy.ts:947`)

Keep the existing shape; append audio args only when requested so the
no-audio arg list stays byte-for-byte identical to today's (existing tests then
need no change):

```ts
const { audio = false, audioSource = "output", audioDup = false } = options

const args = [ /* …unchanged… */, `audio=${audio}` ]

if (audio) {
  args.push(
    "audio_codec=raw",          // see D2: raw only until frame-meta support lands
    `audio_source=${audioSource}`,
  )
  if (audioDup) args.push("audio_dup=true")
}
```

`audio=false` replaces the current hardcoded literal. Note `audio_bit_rate` is
meaningless for raw and is deliberately omitted.

### A.4 `parseAudioHeader` — new pure function

Pure and exported, so it is unit-testable without a device (same pattern as
`videoMetaLayout` / `formatConnectFailure`):

```ts
export type AudioHeader =
  | { kind: "codec"; codec: "raw" | "opus" | "aac" | "flac" }
  | { kind: "disabled" }        // 0: no capture, keep mirroring video
  | { kind: "error" }           // 1: fatal server-side config error
  | { kind: "unknown"; id: number }

export function parseAudioHeader(buffer: Buffer): AudioHeader
```

### A.5 `receiveAudioHeader` — socket read

Modelled on `receiveDeviceMeta` (`src/utils/scrcpy.ts:1205`), including the
**overflow rule**: anything past the first 4 bytes is already PCM and must be
handed back, not dropped.

```ts
const receiveAudioHeader = async (
  socket: net.Socket, port: number
): Promise<{ header: AudioHeader; overflow: Buffer }>
```

Timeout `AUDIO_HEADER_TIMEOUT_MS` (5 s — `AudioRecord.startRecording()` can lag
behind the socket accept). On timeout, resolve as `{ kind: "disabled" }` rather
than throwing: a session without audio is still a good session.

### A.6 `startSession` wiring (`src/utils/scrcpy.ts:1435`)

Insert the audio connect **between** video and control — order is not negotiable:

1. `connectAndVerify(port)` → video socket (consumes the dummy byte) *(unchanged)*
2. **NEW, only when `options.audio`:** `connectToServer(port)` → audio socket, then `socket.pause()` defensively so no PCM is lost before the header read
3. `connectToServer(port)` → control socket *(unchanged, now third)*
4. `receiveDeviceMeta(videoSocket, …)` *(unchanged)*
5. **NEW:** `receiveAudioHeader(audioSocket, port)`

Map the header result onto the session:

| Result | `audioAvailable` | Action |
|--------|------------------|--------|
| `codec: "raw"` | `true` | start the hub, feed it `overflow` first |
| `disabled` | `false` | log "audio unavailable (Android < 11 or capture failed)", destroy the audio socket, continue |
| `error` | `false` | log loudly — the server may be tearing down — destroy socket, continue |
| `unknown` | `false` | log the id, destroy socket, continue |

Degrade exactly like the existing `videoAvailable` path: never fail the session
over audio. Extend the existing `console.error` summary line with the audio state.

### A.7 Lifecycle & restart

**`stopSession` (`src/utils/scrcpy.ts:1585`):** destroy `audioSocket`, stop the
hub, terminate sinks — before `pkill`, alongside the existing video teardown.

**`ensureAudioSession(serial, opts)` — new helper** implementing D3:

```ts
// 1. session exists && session.audioAvailable        → return as-is
// 2. remember whether the MJPEG server runs, and on which port, and whether
//    a viewer window is open
// 3. stopSession(serial)
// 4. startSession(serial, { ...opts, audio: true })
// 5. restore the MJPEG server on the same port, and the viewer if it was open
// 6. return the new session
```

`isMjpegServerRunning(serial)` already exists; the port needs exposing from
`mjpeg.ts` (the `MjpegEntry` records it) via a small `getMjpegPort(serial)`.

### A.8 `AudioHub` (`src/utils/audio.ts` — new file)

```ts
export interface AudioSink {
  id: string
  write(chunk: Buffer): void
  end(): void
}

export function startAudioHub(serial: string, socket: net.Socket, initial?: Buffer): void
export function attachAudioSink(serial: string, sink: AudioSink): void
export function detachAudioSink(serial: string, id: string): boolean
export function listAudioSinks(serial: string): string[]
export function stopAudioHub(serial: string): void
```

Behaviour:
- One `socket.on("data")` handler per serial; writes each chunk to every sink.
- **No sinks ⇒ discard immediately** (D4). No buffering, no queue.
- A sink whose `write` throws is detached and logged — one broken consumer must
  never take down the others or the socket.
- `stopAudioHub` calls `end()` on every sink (so recorders finalise their
  container) before dropping the socket handler.

---

## 6. Phase B — Local Playback

**Where it comes out:** the host's default audio sink (PulseAudio / PipeWire /
ALSA / CoreAudio / WASAPI), from a dedicated `ffplay` process — *not* the
existing MJPEG viewer window, which stays silent (§4).

### B.1 `createPlaybackSink` (`src/utils/audio.ts`)

```ts
spawn(findFfplay(), [
  "-hide_banner", "-loglevel", "error",
  "-nodisp", "-autoexit",
  "-fflags", "nobuffer", "-flags", "low_delay",
  "-f", AUDIO_SAMPLE_FORMAT,
  "-ar", String(AUDIO_SAMPLE_RATE),
  "-ac", String(AUDIO_CHANNELS),
  "-i", "pipe:0",
])
```

Reuse `findFfplay()` from `mjpeg.ts` (export it, or lift both it and
`findFfmpeg()` into a shared helper). Handle `stdin` `EPIPE` the way
`startVideoStream` does. If ffplay fails to spawn (no binary, or a headless host
with no sink), detach the sink and return a clear message rather than throwing.

### B.2 Tools (`src/tools/audio.ts` — new file)

**`start_audio_stream`**

- Input: `serial?`, `audioSource?` (enum, default `output`), `audioDup?` (default `false`)
- Description must state: *"Uses REMOTE_SUBMIX by default, which mutes the device's own speakers while streaming. Use audioSource='playback' with audioDup=true (Android 13+) to keep the device audible. Requires Android 11+. Restarts the scrcpy session if it was started without audio."*
- Flow: `ensureAudioSession` → `attachAudioSink(createPlaybackSink())`
- Output: `status`, `audioSource`, `format` (`"s16le 48000 Hz stereo"`), `deviceMuted` (boolean), `sessionRestarted` (boolean), `message`
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`

**`stop_audio_stream`**

- Input: `serial?`
- Flow: `detachAudioSink(serial, "playback")`; error response if none attached (mirrors `stop_video_stream`)
- Output: `status`, `message`; `idempotentHint: true`

### B.3 Registration

`registerAudioTools(server)` in `src/index.ts`, after `registerVideoTools`.

---

## 7. Phase C — Recording to File

### C.1 `createRecordingSink` (`src/utils/audio.ts`)

```ts
spawn(findFfmpeg(), [
  "-hide_banner", "-loglevel", "error",
  "-f", AUDIO_SAMPLE_FORMAT, "-ar", String(AUDIO_SAMPLE_RATE),
  "-ac", String(AUDIO_CHANNELS), "-i", "pipe:0",
  ...encoderArgs,  // wav → ["-c:a", "pcm_s16le"]; opus → ["-c:a", "libopus", "-b:a", "96k"]
  "-y", outputPath,
])
```

**`end()` must close stdin gracefully and await exit.** A `SIGKILL` leaves a WAV
header with a zero data-size — the file plays as empty. Allow ~2 s for ffmpeg to
finalise, then force-kill as a last resort and say so in the response.

### C.2 Tools (`src/tools/audio.ts`)

**`audio_record_start`** — `serial?`, `localPath?` (default
`./scrcpy-mcp-audio-<timestamp>.wav`), `format?` (`"wav" | "opus"`, default
`"wav"`), `audioSource?`, `audioDup?`. Same `ensureAudioSession` flow; rejects if
a recording sink is already attached. Output: `status`, `localPath`, `format`,
`sessionRestarted`, `message`.

**`audio_record_stop`** — `serial?`. Detaches, awaits finalisation, `stat`s the
file. Output: `status`, `localPath`, `sizeBytes`, `durationSeconds`
(`sizeBytes / (48000 × 2 × 2)` for wav), `message`.

Naming deliberately parallels the existing `screen_record_start` /
`screen_record_stop` in `src/tools/vision.ts:70`.

### C.3 Note on paths

Unlike `screen_record_*`, which records **on the device** and optionally pulls,
audio records **on the host** — the bytes are already here. Say so in the tool
descriptions so the asymmetry doesn't confuse callers.

---

## 8. Phase D — Frame-Meta Support

Prerequisite for both compressed audio codecs (D2) and true A/V sync (Phase E).
`send_frame_meta` is global, so flipping it changes the **video** path too.

### D.1 Constants

```ts
export const FRAME_META_SIZE = 12          // 8-byte pts+flags, 4-byte packet size

// 3.x
export const PACKET_FLAG_CONFIG_V3   = 1n << 63n
export const PACKET_FLAG_KEY_FRAME_V3 = 1n << 62n
// 4.x — every bit shifted down one to make room for SESSION
export const PACKET_FLAG_SESSION_V4  = 1n << 63n
export const PACKET_FLAG_CONFIG_V4   = 1n << 62n
export const PACKET_FLAG_KEY_FRAME_V4 = 1n << 61n
```

### D.2 `frameMetaLayout(version)` + `parseFramePacket`

Exactly the shape of the existing `videoMetaLayout` — version in, bit masks out,
pure and unit-tested against both 3.3.4 and 4.1.

### D.3 Video path migration

`startVideoStream` currently writes raw socket bytes straight into ffmpeg's
stdin. With frame meta on it must strip the 12-byte prefix per packet before
writing. Gate on a single flag so the change is revertible, and re-verify the
first-frame/PositionMapper handshake (`src/utils/scrcpy.ts:415`) still fires —
that handshake is what keeps `tap` from being silently dropped.

### D.4 Compressed audio codecs

With framing available, allow `audioCodec: "opus" | "aac" | "flac"`: buffer the
config packet (flag `CONFIG`) as extradata and feed ffmpeg `-f opus` etc. Lowers
ADB bandwidth from 192 KB/s to ~16 KB/s — the reason to bother over Wi-Fi ADB.

---

## 9. Phase E — Synced A/V Viewer

### E.1 Tee the h264

`videoSocket.on("data")` already funnels through Node
(`src/utils/scrcpy.ts:498`), so add a second consumer there. **Do not** open a
second scrcpy session — the device allows one encoder, and a second client evicts
the MCP's own session (see the `mjpeg.ts:106` comment).

### E.2 Mux process

```
ffmpeg -fflags nobuffer -flags low_delay
       -f h264 -i pipe:0
       -f s16le -ar 48000 -ac 2 -i pipe:3
       -c:v copy -c:a aac -f mpegts pipe:1
```

`stdio: ["pipe", "pipe", "pipe", "pipe"]` gives fd 3 for PCM. Serve `pipe:1` as a
single chunked HTTP response (`Content-Type: video/mp2t`) on a second port and
point one `ffplay` at it. MPEG-TS is built for exactly this.

### E.3 Why this needs Phase D

With `send_frame_meta=false` the h264 stream has **no timestamps** — the precise
problem called out in `mjpeg.ts:106` that made ffplay stall and pushed the
project to MJPEG in the first place. Real PTS come from frame meta. Without
Phase D the only option is `-use_wallclock_as_timestamps 1` on both inputs, which
gives approximate arrival-time sync and degrades under load.

### E.4 Keep MJPEG alive

`screenshot` and `getLatestFrame` depend on the JPEG pump. Phase E **adds** a
consumer; it does not replace the MJPEG path.

---

## 10. Phase F — Agent-Facing Capture

**Where it comes out:** the MCP response itself, as an `audio` content block —
the third destination, next to Phase B's speakers and Phase C's file. Rationale
and the shape of the choice are in [D9](#d9--the-agent-gets-a-clip-not-a-stream).

### F.1 `createClipSink` (`src/utils/audio.ts`)

The same ffmpeg shape as `createRecordingSink`, writing to a temp file under the
OS temp dir instead of a caller-supplied path, then read back and base64-encoded:

```ts
spawn(findFfmpeg(), [
  "-hide_banner", "-loglevel", "error",
  "-f", AUDIO_SAMPLE_FORMAT, "-ar", String(AUDIO_SAMPLE_RATE),
  "-ac", String(AUDIO_CHANNELS), "-i", "pipe:0",
  "-c:a", "libopus", "-b:a", "48k",
  "-y", tmpPath,                      // .ogg
])
```

Reuse C.1's graceful-stdin-close discipline verbatim — a force-killed encoder
yields a truncated clip. Delete the temp file in a `finally`, on the error paths
as well as the happy one.

**libopus fallback.** D8 treats a missing libopus as an opt-in risk; here it sits
on the default path. If the encoder is unavailable, fall back to `wav` and halve
the default duration so the content block stays manageable, and report which one
was used in `mimeType`.

### F.2 `audio_capture` (`src/tools/audio.ts`)

- Input: `serial?`, `durationSeconds?` (default `5`, `.int().positive().max(30)`), `audioSource?`, `audioDup?`
- Description must carry the same muting warning as the other audio tools (D1), plus: *"Returns the audio to the caller as an audio content block — use audio_record_start to write a long capture to a file on the host instead."*
- Flow: `ensureAudioSession` → attach the clip sink → wait `durationSeconds` → detach → read → base64
- Output: `status`, `durationSeconds`, `sizeBytes`, `mimeType` (`audio/ogg` or `audio/wav`), `audioSource`, `deviceMuted`, `sessionRestarted`, `message`
- Annotations: `readOnlyHint: false` (the default source mutes the device), `idempotentHint: false`, `openWorldHint: true`

Return **two** content blocks, so a client that ignores audio still gets
something useful (R9):

```ts
return {
  content: [
    { type: "audio" as const, data: base64, mimeType },
    { type: "text" as const, text: JSON.stringify(structured, null, 2) },
  ],
  structuredContent: structured,
}
```

This is the first non-`image` binary content block in the server; `screenshot`
(`src/tools/vision.ts`) is the pattern to follow for the base64 handling, and the
response-format table in AGENTS.md needs the `audio` row added (§13).

### F.3 Coexistence with the other sinks

The hub already fans out to every attached sink (D4), so a capture taken during
an active recording or playback is fine by construction — and must be tested as
such rather than assumed, since it is the first case where two encoder sinks run
at once.

---

## 11. Phase G — Robustness & Limits

A–C are correct while everything works. G covers the two cases they don't: a
capture nobody stops, and a device that disappears mid-capture.

### G.1 Bounded recordings

`audio_record_start` gains:

- `maxDuration?` — seconds, `.int().positive().max(3600)`, default `300`. Nothing
  device-side enforces this (unlike `screen_record_*`, where the device does), so
  a host-side timer detaches the sink and finalises the file by exactly the path
  `audio_record_stop` uses.
- A size budget of `maxDuration` × the format's rate — 192 000 B/s for WAV,
  12 000 B/s (96 kbps) for opus — checked against free space on the target
  volume **before** ffmpeg is spawned. Refuse up front, quoting both numbers,
  rather than discovering it when the disk fills.

`audio_record_stop` gains `stoppedReason: "user" | "maxDuration" | "deviceLost"`.
A stop that arrives after an auto-finalise returns the completed file rather than
"no recording is in progress" — the recording happened; only the stop call was
late.

### G.2 Mid-capture device loss

A.7 covers orderly teardown through `stop_session`. Not covered: a USB unplug,
`adb disconnect`, an Android 11 screen lock after the session started, or the
audio socket ending while video survives.

`onAudioHubStopped` (`src/utils/audio.ts:34`) is already the hook — it fires when
the hub tears down. G makes every sink answer it:

- **Recording:** finalise the partial file and keep it, with
  `stoppedReason: "deviceLost"`. Never discard bytes already captured.
- **Playback:** close ffplay's stdin so it exits via `-autoexit` instead of
  lingering as an orphan.
- **Clip (F):** resolve the pending capture early with `status: "truncated"`
  and whatever was collected; error only when the clip came out empty.

`audio_record_stop` then reports the loss with `stoppedReason: "deviceLost"`.
`stop_audio_stream` instead finds nothing to stop: the hub teardown already
ended the sink, and the tool dropped its entry, so it answers "no audio stream
is playing" rather than reporting on a sink that quietly died.

### G.3 Resolve R6 properly

A.0 — *resolve R6 on a real device before writing code* — was never ticked, and
A–C shipped anyway. The question is still open on paper: does a terminating audio
thread tear down the whole scrcpy server? G.2 is where the answer changes
behaviour, so close it here. Verify on a real Android 11 device and on an
emulator with no audio; then either retire R6 or build the separate-session
fallback it warns about.

---

## 12. Testing Strategy

### Unit (`tests/audio.test.ts`, `tests/scrcpy-protocol.test.ts`)

Follow the existing pure-function discipline — no device required:

- `parseAudioHeader`: raw/opus/aac/flac ids; `0` → disabled; `1` → error; garbage → unknown
- `buildServerArgs`: `audio=false` by default and the arg list unchanged from today; `audio=true` adds `audio_codec=raw` + `audio_source=…`; `audioDup` adds `audio_dup=true`; **assert for both `"3.3.4"` and `"4.1"`** (extend the existing `it.each` in `tests/scrcpy-version.test.ts:124`)
- `AudioHub`: chunks reach every attached sink; a detached sink stops receiving; zero sinks doesn't throw; a throwing sink is detached without disturbing the others
- Recording duration math from byte count
- Phase D: `frameMetaLayout` flag bits differ between 3.x and 4.x
- Phase F: clip duration/size math; the opus→wav fallback reports the matching `mimeType`; the temp file is deleted on success, on encoder failure, and on device loss
- Phase G: the `maxDuration` timer finalises exactly once even when `audio_record_stop` races it; the free-space refusal fires *before* ffmpeg is spawned; every sink type detaches cleanly from `onAudioHubStopped`

### Integration (`tests/integration/audio.test.ts`)

Needs a real device; follow the existing `global-setup.ts` / `mcp-client.ts`
pattern. **Skip when `ro.build.version.sdk < 30`** — CI emulators and older
devices legitimately have no audio.

- `start_audio_stream` on an audio-less session restarts it and reports `sessionRestarted: true`
- After restart, `tap` still works (control socket re-established) and `screenshot` still returns an image
- `audio_record_start` → ~3 s → `audio_record_stop` produces a file whose size is within ±20 % of `3 × 192000` bytes
- `stop_audio_stream` with nothing attached returns an error response, not a throw
- Phase F: `audio_capture` returns a block with `type: "audio"` whose `data` decodes to a non-empty ogg of about the requested length
- Phase F: a capture taken during an active recording leaves that recording intact (hub fan-out, F.3)
- Phase G: `maxDuration: 2` finalises the file with no stop call and reports `stoppedReason: "maxDuration"`
- Phase G: `adb disconnect` mid-recording keeps a playable partial file and reports `stoppedReason: "deviceLost"`

### Manual

1. `start_audio_stream`, play something on the phone → sound from host speakers, **phone goes silent** (expected with `output`)
2. Repeat with `audioSource: "playback"`, `audioDup: true` on an Android 13+ device → both audible
3. Android 11 with the screen locked at session start → expect `disabled`, session still fully usable
4. `stop_session` while playback runs → ffplay exits, no orphan processes (`pgrep ffplay`)
5. Phase G: pull the USB cable mid-recording → the partial `.wav` is playable, no orphan encoder (`pgrep ffmpeg`)

---

## 13. Documentation Updates

Done for A–C:

- **README.md** — bump the tool count (36 → 40); add audio to Features; new tool-reference rows; prerequisites note (**Android 11+**, ffplay for playback); a short "Audio" section carrying the muting warning prominently
- **AGENTS.md** — add `audio.ts` to both the `utils/` and `tools/` trees in Project Structure
- **ROADMAP.md** — Phase 6.2 checklist (below)
- **PLAN.md** — extend the tool inventory in §5
- **AUDIO_PLAN.md** — this file

Still owed by F and G:

- **README.md** — tool count 40 → 41 for `audio_capture`; a row in the audio table; note the `maxDuration` default on `audio_record_start`
- **AGENTS.md** — add the `audio` block to the Tool Response Format list, which currently shows only `text` and `image`
- **PLAN.md** — §5.3c becomes 5 tools; update the inventory total in the table at the end of §5
- **ROADMAP.md** — 6.2.6 and 6.2.7

---

## 14. Risks & Open Questions

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | **`output` mutes the device.** Surprising; looks like a bug. | Opt-in (D1); stated in every audio tool description and in each response payload via `deviceMuted`. |
| R2 | **Enabling audio restarts the session**, briefly dropping control + video. | `sessionRestarted` in the response; MJPEG server and viewer restored on the same port (A.7). |
| R3 | Android < 11 has no audio at all. | Header sentinel `0` handled as a normal degraded path; never fails the session. |
| R4 | 192 KB/s continuous over ADB — fine on USB, heavy on Wi-Fi ADB. | Documented; Phase D's opus support is the fix. |
| R5 | Headless host (container, CI, SSH) has no audio sink — ffplay fails. | Detect spawn failure, detach, return an actionable message. Recording (Phase C) still works there. |
| R6 | **Open question:** does a non-fatal audio-thread termination tear down the whole server? `AudioRawRecorder` calls `listener.onTerminated(false)`, and `Completion` stops the server when all processors finish. | **Still open.** A.0 said resolve it before Phase B; A–C shipped without it being recorded as done. Now owned by [G.3](#g3-resolve-r6-properly): verify on a real Android 11 device and on an emulator with no audio, confirming video + control survive. If they don't, audio must run in a *separate* scrcpy session — which would change A.7 substantially. |
| R7 | Phase B has no A/V sync. | Accepted (D5); Phase E is the answer if it matters. |
| R8 | Phase D flips a global flag and touches the working video path. | Gate behind a flag; re-verify the first-frame/PositionMapper handshake, since a regression there silently breaks `tap`. |
| R9 | Not every MCP client renders `audio` content blocks. | `audio_capture` returns a paired `text` block with the JSON, so a client that drops the audio still gets the metadata and the error path (F.2). |
| R10 | `audio_capture` blocks for its full duration. | Hard `.max(30)` in the schema and a 5 s default, so a mistyped duration can't stall an automation run (D9). |
| R11 | Base64 audio is expensive in context. | Opus by default (~0.1 MB for 10 s); duration capped; raw PCM is never returned inline (D9). |
| R12 | In Phase G a `maxDuration` timer and a user stop can race. | One finalise path, guarded so it runs exactly once, whichever arrives first; unit-tested (G.1). |

---

## 15. Task Checklist

**Build order: A → C → B** (shipped), then **F → G**. D and E are deferred (see
the Decisions Log). Sections below stay in letter order for cross-referencing.

### Phase A — Transport Foundation

- [ ] A.0 **Resolve R6** on a real device — **still open**; A–C shipped without it. Now owned by [G.3](#g3-resolve-r6-properly)
- [x] A.1 Add audio constants to `src/utils/constants.ts`
- [x] A.2 Extend `ScrcpySessionOptions` and `ScrcpySession`
- [x] A.3 Add audio args to `buildServerArgs`, replacing the hardcoded `audio=false`
- [x] A.4 Implement + export `parseAudioHeader`
- [x] A.5 Implement `receiveAudioHeader` with overflow preservation
- [x] A.6 Wire the audio socket into `startSession` **between** video and control
- [x] A.7 Audio teardown in `stopSession`; `ensureAudioSession`; `getMjpegPort`
- [x] A.8 Implement `AudioHub` in `src/utils/audio.ts`
- [x] A.9 Unit tests for A.3–A.4 and the hub

### Phase B — Local Playback

- [x] B.1 `createPlaybackSink` (ffplay, `-nodisp`)
- [x] B.2 `start_audio_stream` / `stop_audio_stream` in `src/tools/audio.ts`
- [x] B.3 Register in `src/index.ts`
- [x] B.4 Integration test + manual checks 1–4

### Phase C — Recording

- [x] C.1 `createRecordingSink` with graceful stdin close
- [x] C.2 `audio_record_start` / `audio_record_stop`
- [x] C.3 Duration/size math + tests

### Phase F — Agent-Facing Capture

- [x] F.1 `createClipSink` — temp-file encode, guaranteed cleanup, opus→wav fallback
- [x] F.2 `audio_capture` returning paired `audio` + `text` content blocks
- [x] F.3 Register in `src/index.ts`; verify coexistence with an active recording/playback sink
- [x] F.4 Unit tests (clip math, fallback `mimeType`, temp-file cleanup) + integration test

### Phase G — Robustness & Limits

- [x] G.1 `maxDuration` (default 300 s), size budget, pre-flight free-space check, `stoppedReason`
- [x] G.2 Every sink handles `onAudioHubStopped`: finalise partials, no orphan processes
- [ ] G.3 **Resolve R6** — real Android 11 device + audio-less emulator; retire R6 or build the separate-session fallback
- [ ] G.4 Unit tests (timer/stop race, free-space refusal) + integration tests + manual check 5 — unit tests and the recording/clip/`maxDuration` integration tests pass; the device-loss integration test still has to pass over wireless ADB (it now skips on USB serials)

### Phase D — Frame Meta *(optional)*

- [ ] D.1 Frame-meta constants for 3.x and 4.x
- [ ] D.2 `frameMetaLayout` + `parseFramePacket` + tests
- [ ] D.3 Migrate the video path behind a flag; re-verify the first-frame handshake
- [ ] D.4 opus/aac/flac audio codecs

### Phase E — Synced A/V Viewer *(optional)*

- [ ] E.1 Tee h264 in `startVideoStream`
- [ ] E.2 Mux process + MPEG-TS HTTP server
- [ ] E.3 `start_av_stream` / `stop_av_stream`
- [ ] E.4 Confirm MJPEG + screenshots unaffected

### Ship — A–C

- [x] `npm run lint` · `npm run build` · `npm run test` — clean, 211 unit tests passing (2026-09-22)
- [ ] `npm run inspect` — verify the new tools; not recorded as run
- [x] README / AGENTS / PLAN / ROADMAP updates — README Audio section + 40-tool count, AGENTS `audio.ts` in both trees, PLAN §5.3c, ROADMAP 6.2.1–6.2.3
- [ ] Version bump + changelog — **outstanding**: audio landed in #62, *after* the v0.5.0 release (#61), so `package.json` is still `0.5.0` and the feature is unreleased

### Ship — F + G

- [ ] `npm run lint` · `npm run build` · `npm run test`
- [ ] `npm run inspect` — verify `audio_capture` renders its audio block
- [ ] README / AGENTS / PLAN / ROADMAP updates (§13)
- [ ] Version bump + changelog
