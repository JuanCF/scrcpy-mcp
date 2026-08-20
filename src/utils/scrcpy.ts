import { spawn, execFileSync, ChildProcess } from "child_process"
import { createRequire } from "module"
import * as net from "net"
import * as path from "path"
import { StringDecoder } from "string_decoder"
import * as fs from "fs"
import { execAdb, execAdbShell, resolveSerial, getScreenSize } from "./adb.js"
import {
  ADB_PATH,
  SCRCPY_SERVER_PORT,
  SCRCPY_SERVER_PATH_LOCAL,
  SCRCPY_SERVER_VERSION,
  CONTROL_MSG_TYPE_INJECT_KEYCODE,
  CONTROL_MSG_TYPE_INJECT_TEXT,
  CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT,
  CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT,
  CONTROL_MSG_TYPE_SET_DISPLAY_POWER,
  CONTROL_MSG_TYPE_EXPAND_NOTIFICATION_PANEL,
  CONTROL_MSG_TYPE_EXPAND_SETTINGS_PANEL,
  CONTROL_MSG_TYPE_COLLAPSE_PANELS,
  CONTROL_MSG_TYPE_GET_CLIPBOARD,
  CONTROL_MSG_TYPE_SET_CLIPBOARD,
  CONTROL_MSG_TYPE_ROTATE_DEVICE,
  CONTROL_MSG_TYPE_START_APP,
  DISPLAY_POWER_MODE_OFF,
  DISPLAY_POWER_MODE_ON,
  TEXT_MAX_LENGTH,
  MAX_JPEG_BUFFER_SIZE,
  JPEG_SOI,
  JPEG_EOI,
  DEVICE_MSG_TYPE_CLIPBOARD,
  DEVICE_MSG_TYPE_ACK_CLIPBOARD,
  DEVICE_MSG_ACK_CLIPBOARD_SIZE,
  MAX_CLIPBOARD_BYTES,
  CLIPBOARD_COPY_KEY_NONE,
  DEVICE_META_SIZE,
  DEVICE_NAME_OFFSET,
  VIDEO_WIDTH_OFFSET,
  VIDEO_HEIGHT_OFFSET,
  V4_DEVICE_META_SIZE,
  V4_VIDEO_WIDTH_OFFSET,
  V4_VIDEO_HEIGHT_OFFSET,
} from "./constants.js"

export function serializeInjectKeycode(
  action: number,
  keycode: number,
  repeat = 0,
  metaState = 0
): Buffer {
  const buffer = Buffer.alloc(14)
  let offset = 0
  buffer.writeUInt8(CONTROL_MSG_TYPE_INJECT_KEYCODE, offset++)
  buffer.writeUInt8(action, offset++)
  buffer.writeInt32BE(keycode, offset)
  offset += 4
  buffer.writeInt32BE(repeat, offset)
  offset += 4
  buffer.writeInt32BE(metaState, offset)
  return buffer
}

export function serializeInjectText(text: string): Buffer {
  const textBytes = Buffer.from(text, "utf8")
  if (textBytes.length > TEXT_MAX_LENGTH) {
    throw new Error(`Text too long: ${textBytes.length} bytes (max ${TEXT_MAX_LENGTH})`)
  }
  const buffer = Buffer.alloc(5 + textBytes.length)
  let offset = 0
  buffer.writeUInt8(CONTROL_MSG_TYPE_INJECT_TEXT, offset++)
  buffer.writeUInt32BE(textBytes.length, offset)
  offset += 4
  textBytes.copy(buffer, offset)
  return buffer
}

const floatToU16FP = (f: number): number => {
  f = Math.max(0, Math.min(f, 1))
  const u = Math.round(f * 65536)
  return Math.min(u, 0xffff)
}

const floatToI16FP = (f: number): number => {
  f = Math.max(-1, Math.min(f, 1))
  const i = Math.round(f * 32768)
  return Math.max(-0x8000, Math.min(i, 0x7fff))
}

export function serializeInjectTouchEvent(
  action: number,
  pointerId: bigint,
  x: number,
  y: number,
  screenWidth: number,
  screenHeight: number,
  pressure: number,
  buttons = 0,
  actionButton = 0
): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt8(CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT, 0)
  buffer.writeUInt8(action, 1)
  buffer.writeBigUInt64BE(BigInt.asUintN(64, pointerId), 2)
  buffer.writeInt32BE(x, 10)
  buffer.writeInt32BE(y, 14)
  buffer.writeUInt16BE(screenWidth, 18)
  buffer.writeUInt16BE(screenHeight, 20)
  buffer.writeUInt16BE(floatToU16FP(pressure), 22)
  buffer.writeUInt32BE(actionButton, 24)
  buffer.writeUInt32BE(buttons, 28)
  return buffer
}

export function serializeInjectScrollEvent(
  x: number,
  y: number,
  screenWidth: number,
  screenHeight: number,
  hScroll: number,
  vScroll: number,
  buttons = 0
): Buffer {
  const buffer = Buffer.alloc(21)
  buffer.writeUInt8(CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT, 0)
  buffer.writeInt32BE(x, 1)
  buffer.writeInt32BE(y, 5)
  buffer.writeUInt16BE(screenWidth, 9)
  buffer.writeUInt16BE(screenHeight, 11)
  const hNorm = Math.max(-1, Math.min(hScroll / 16, 1))
  const vNorm = Math.max(-1, Math.min(vScroll / 16, 1))
  buffer.writeInt16BE(floatToI16FP(hNorm), 13)
  buffer.writeInt16BE(floatToI16FP(vNorm), 15)
  buffer.writeUInt32BE(buttons, 17)
  return buffer
}

export function serializeSetDisplayPower(on: boolean): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt8(CONTROL_MSG_TYPE_SET_DISPLAY_POWER, 0)
  buffer.writeUInt8(on ? DISPLAY_POWER_MODE_ON : DISPLAY_POWER_MODE_OFF, 1)
  return buffer
}

export function serializeExpandNotificationPanel(): Buffer {
  return Buffer.from([CONTROL_MSG_TYPE_EXPAND_NOTIFICATION_PANEL])
}

export function serializeExpandSettingsPanel(): Buffer {
  return Buffer.from([CONTROL_MSG_TYPE_EXPAND_SETTINGS_PANEL])
}

export function serializeCollapsePanels(): Buffer {
  return Buffer.from([CONTROL_MSG_TYPE_COLLAPSE_PANELS])
}



export function serializeGetClipboard(copyKey = CLIPBOARD_COPY_KEY_NONE): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt8(CONTROL_MSG_TYPE_GET_CLIPBOARD, 0)
  buffer.writeUInt8(copyKey, 1)
  return buffer
}

export function serializeSetClipboard(
  sequence: bigint,
  text: string,
  paste = false
): Buffer {
  const textBytes = Buffer.from(text, "utf8")
  const buffer = Buffer.alloc(14 + textBytes.length)
  buffer.writeUInt8(CONTROL_MSG_TYPE_SET_CLIPBOARD, 0)
  buffer.writeBigUInt64BE(sequence, 1)
  buffer.writeUInt8(paste ? 1 : 0, 9)
  buffer.writeUInt32BE(textBytes.length, 10)
  textBytes.copy(buffer, 14)
  return buffer
}

export function serializeRotateDevice(): Buffer {
  return Buffer.from([CONTROL_MSG_TYPE_ROTATE_DEVICE])
}

export function serializeStartApp(packageName: string): Buffer {
  const nameBytes = Buffer.from(packageName, "utf8")
  if (nameBytes.length > 255) {
    throw new Error(`Package name too long: ${nameBytes.length} bytes (max 255)`)
  }
  const buffer = Buffer.alloc(2 + nameBytes.length)
  buffer.writeUInt8(CONTROL_MSG_TYPE_START_APP, 0)
  buffer.writeUInt8(nameBytes.length, 1)
  nameBytes.copy(buffer, 2)
  return buffer
}

export function sendControlMessage(serial: string, message: Buffer): void {
  const session = getSession(serial)
  if (!session || !session.controlSocket || session.controlSocket.destroyed) {
    throw new Error(`No active scrcpy session for device ${serial}`)
  }
  session.controlSocket.write(message)
}

let clipboardSequence = BigInt(0)

function getNextClipboardSequence(): bigint {
  clipboardSequence = clipboardSequence + BigInt(1)
  return clipboardSequence
}

export async function getClipboardViaScrcpy(
  serial: string,
  timeout = 5000
): Promise<string | null> {
  const session = getSession(serial)
  if (!session || !session.controlSocket || session.controlSocket.destroyed) {
    throw new Error(`No active scrcpy session for device ${serial}`)
  }

  session.clipboardContent = null

  const msg = serializeGetClipboard(CLIPBOARD_COPY_KEY_NONE)
  sendControlMessage(serial, msg)

  const startTime = Date.now()
  while (Date.now() - startTime < timeout) {
    if (session.clipboardContent !== null) {
      return session.clipboardContent
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return null
}

export async function setClipboardViaScrcpy(
  serial: string,
  text: string,
  paste = false
): Promise<void> {
  const session = getSession(serial)
  if (!session || !session.controlSocket || session.controlSocket.destroyed) {
    throw new Error(`No active scrcpy session for device ${serial}`)
  }

  const sequence = getNextClipboardSequence()
  const msg = serializeSetClipboard(sequence, text, paste)
  sendControlMessage(serial, msg)
}

export async function startAppViaScrcpy(
  serial: string,
  packageName: string
): Promise<void> {
  const session = getSession(serial)
  if (!session || !session.controlSocket || session.controlSocket.destroyed) {
    throw new Error(`No active scrcpy session for device ${serial}`)
  }

  const msg = serializeStartApp(packageName)
  sendControlMessage(serial, msg)
}

export interface ScrcpySessionOptions {
  maxSize?: number
  maxFps?: number
  videoBitRate?: number
}

export interface ScrcpySession {
  serial: string
  scid: number
  controlSocket: net.Socket | null
  videoSocket: net.Socket | null
  videoProcess: ChildProcess | null
  frameBuffer: Buffer | null
  // Native device resolution (from `wm size`). This is the coordinate space
  // callers use — it matches ui_dump / ui_find_element bounds and `input tap`.
  screenSize: { width: number; height: number }
  // The scrcpy encoder/video frame size (downscaled by max_size). The scrcpy
  // touch protocol requires the touch message's screenSize to EXACTLY equal
  // this; otherwise the server's PositionMapper silently discards the event.
  // Input helpers scale native coords into this space before sending.
  frameSize: { width: number; height: number }
  // False when the scrcpy video stream could not be established (e.g. the
  // device/emulator has no usable h264 encoder, so device metadata never
  // arrived). The session is still usable for control (input/clipboard/etc.)
  // via the control socket; screenshots fall back to `adb screencap`.
  videoAvailable: boolean
  clipboardContent: string | null
  viewerProcess: ChildProcess | null  // the native scrcpy viewer window, if open
}

const sessions: Map<string, ScrcpySession> = new Map()

export function getSession(serial: string): ScrcpySession | undefined {
  return sessions.get(serial)
}

export function hasActiveSession(serial: string): boolean {
  const session = sessions.get(serial)
  return session !== undefined && session.controlSocket !== null && !session.controlSocket.destroyed
}

export function getLatestFrame(serial: string): Buffer | null {
  const session = sessions.get(serial)
  return session?.frameBuffer ?? null
}

const findFfmpeg = (): string => {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH
  }
  try {
    const ffmpegStatic: string | null = createRequire(import.meta.url)("ffmpeg-static")
    // ffmpeg-static resolves to a path even when its postinstall binary
    // download was skipped/failed, so verify the file actually exists before
    // returning it. Otherwise spawn fails with ENOENT and the video socket
    // teardown cascades into killing the whole scrcpy session.
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      try {
        fs.accessSync(ffmpegStatic, fs.constants.X_OK)
        return ffmpegStatic
      } catch {
        // file exists but is not executable, fall back to system ffmpeg
      }
    }
  } catch {
    // ffmpeg-static not installed, fall back to system ffmpeg
  }
  return "ffmpeg"
}

function startVideoStream(
  session: ScrcpySession,
  videoSocket: net.Socket,
  initialData?: Buffer
): Promise<void> {
  const ffmpegPath = findFfmpeg()
  
  const ffmpeg = spawn(ffmpegPath, [
    // Keep stderr to genuine errors only: drop the startup banner, the
    // input/output/stream-mapping dump, warnings, and the repeating
    // "frame= …" progress lines. Real decode/encode errors still surface.
    "-hide_banner",
    "-loglevel", "error",
    "-nostats",
    "-probesize", "1024",
    "-flags", "low_delay",
    "-f", "h264",
    "-i", "pipe:0",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", "5",
    "-flush_packets", "1",
    "pipe:1",
  ])

  session.videoProcess = ffmpeg
  session.videoSocket = videoSocket

  let jpegBuffer = Buffer.alloc(0)
  let firstFrameReceived = false
  let resolveFirstFrame: (() => void) | null = null

  const firstFramePromise = new Promise<void>((resolve) => {
    resolveFirstFrame = resolve
  })

  // Timeout: if no frame arrives within 10 seconds, resolve anyway
  // (session is still usable for non-vision tools)
  const firstFrameTimeout = setTimeout(() => {
    if (!firstFrameReceived) {
      const msg = `[scrcpy] [${session.serial}] Timeout waiting for` +
        ` first video frame, proceeding without it`
      console.error(msg)
      firstFrameReceived = true
      resolveFirstFrame?.()
    }
  }, 10000)

  ffmpeg.stdout?.on("data", (chunk: Buffer) => {
    jpegBuffer = Buffer.concat([jpegBuffer, chunk])

    if (jpegBuffer.length > MAX_JPEG_BUFFER_SIZE) {
      console.error(`[scrcpy] [${session.serial}] JPEG buffer exceeded max size, resetting`)
      jpegBuffer = Buffer.alloc(0)
      return
    }
    
    let soiIdx = -1
    for (let i = 0; i < jpegBuffer.length - 1; i++) {
      if (jpegBuffer.readUInt16BE(i) === JPEG_SOI) {
        soiIdx = i
        break
      }
    }
    
    if (soiIdx === -1) {
      return
    }
    
    if (soiIdx > 0) {
      jpegBuffer = jpegBuffer.subarray(soiIdx)
    }
    
    while (jpegBuffer.length > 4) {
      let eoiIdx = -1
      for (let i = 2; i < jpegBuffer.length - 1; i++) {
        if (jpegBuffer.readUInt16BE(i) === JPEG_EOI) {
          eoiIdx = i
          break
        }
      }
      
      if (eoiIdx === -1) {
        break
      }
      
      const frame = jpegBuffer.subarray(0, eoiIdx + 2)
      session.frameBuffer = Buffer.from(frame)
      jpegBuffer = jpegBuffer.subarray(eoiIdx + 2)

      // Signal that the first frame has been received. This ensures the
      // scrcpy server's PositionMapper (set via onNewVirtualDisplay) is
      // initialized before we send any touch events, preventing the
      // server from silently discarding them due to a size mismatch.
      if (!firstFrameReceived) {
        firstFrameReceived = true
        clearTimeout(firstFrameTimeout)
        const msg = `[scrcpy] [${session.serial}]` +
          ` First video frame received, session fully ready`
        console.error(msg)
        resolveFirstFrame?.()
      }
    }
  })

  ffmpeg.stderr?.on("data", (data: Buffer) => {
    console.error(`[scrcpy] [${session.serial}] ffmpeg stderr: ${data.toString().trim()}`)
  })

  // When ffmpeg dies (e.g. missing binary, decode error) we deliberately do
  // NOT tear down the video socket. The socket's "data" handler keeps draining
  // bytes (discarding them once ffmpeg is gone), which keeps the scrcpy server
  // alive so the control socket — and therefore input tools like tap/text/key —
  // continue to work. Only screenshots/video are lost. The first-frame promise
  // is resolved (not rejected) so the session is reported as usable.
  ffmpeg.on("error", (err: Error) => {
    console.error(`[scrcpy] ffmpeg error for ${session.serial}:`, err.message)
    session.frameBuffer = null
    session.videoProcess = null
    if (!firstFrameReceived) {
      firstFrameReceived = true
      clearTimeout(firstFrameTimeout)
      resolveFirstFrame?.()
    }
  })

  ffmpeg.on("exit", (code: number | null) => {
    session.videoProcess = null
    if (code !== 0 && code !== null) {
      console.error(`[scrcpy] ffmpeg exited with code ${code} for ${session.serial}`)
      session.frameBuffer = null
      if (!firstFrameReceived) {
        firstFrameReceived = true
        clearTimeout(firstFrameTimeout)
        resolveFirstFrame?.()
      }
    }
  })

  videoSocket.on("error", (err: Error) => {
    console.error(`[scrcpy] Video socket error for ${session.serial}:`, err.message)
    session.videoSocket = null
  })

  videoSocket.on("close", () => {
    session.videoSocket = null
  })

  if (ffmpeg.stdin) {
    ffmpeg.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        console.error(`[scrcpy] ffmpeg stdin EPIPE for ${session.serial}`)
      } else {
        console.error(`[scrcpy] ffmpeg stdin error for ${session.serial}:`, err.message)
      }
    })

    // Feed the raw H.264 stream into ffmpeg, which extracts JPEG frames for
    // screenshots and the MJPEG HTTP stream. (The native scrcpy viewer window,
    // when open, runs its own independent server and does not read from here.)
    // Write any overflow bytes captured during the metadata read first.
    if (initialData && initialData.length > 0) {
      ffmpeg.stdin.write(initialData)
    }
    videoSocket.on("data", (chunk: Buffer) => {
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        try { ffmpeg.stdin.write(chunk) } catch { /* EPIPE handled above */ }
      }
    })
  }

  return firstFramePromise
}

// Existence alone is not enough for either the scrcpy binary or the server: a
// directory satisfies existsSync, and `adb push <dir>` then creates the remote
// scrcpy-server.jar as a directory, which fails later with a confusing error.
// Rejecting non-files here keeps that mistake local and legible.
function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function findScrcpyBinaryOnPath(): string | null {
  const command = process.platform === "win32" ? "where" : "which"
  try {
    const output = execFileSync(command, ["scrcpy"], {
      encoding: "utf8",
      timeout: 5000,
    })
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const line of lines) {
      if (isExistingFile(line)) {
        return line
      }
    }
  } catch {
    // scrcpy not on PATH or lookup failed
  }
  return null
}

// Upstream ships exactly two layouts, and both keep the client and the server
// one relative step apart:
//
//   portable/flat   <dir>/scrcpy          <dir>/scrcpy-server
//   prefix install  <prefix>/bin/scrcpy   <prefix>/share/scrcpy/scrcpy-server
//
// The flat form comes from the release archives (Windows zip, Linux tar.gz and
// macOS all build with -Dportable=true); the prefix form from `ninja install`,
// install_release.sh and distro packages, where server/meson.build installs to
// 'share/scrcpy' and the client compiles in PREFIX "/share/scrcpy/". Deriving
// one end from the other is therefore exact rather than a guess, and it adapts
// to any prefix -- /usr, /usr/local, /opt/homebrew, a Nix store path, Termux --
// without naming a single absolute location.
const SERVER_FILENAME = "scrcpy-server"

function clientFilename(): string {
  return process.platform === "win32" ? "scrcpy.exe" : "scrcpy"
}

// Where to look for a file's counterpart, most specific first.
//
// Symlink farms (Homebrew's bin/scrcpy -> Cellar/scrcpy/<v>/bin/scrcpy) would
// otherwise derive the counterpart from the link's directory instead of the
// install's -- and the link is usually the file itself, not its directory, so
// the whole path has to be resolved rather than just the parent. Both
// directories are searched: the resolved one is where the install keeps its own
// files, while the link's directory is what anchors the <prefix>/share layout
// for a distro that symlinks only the binary. A path that cannot be resolved
// contributes just its literal directory, so a broken symlink degrades to
// "not found" rather than throwing.
function installDirsOf(filePath: string): string[] {
  const dirs = [path.dirname(filePath)]
  try {
    dirs.unshift(path.dirname(fs.realpathSync(filePath)))
  } catch {
    // Unresolvable link: its literal directory is all there is to go on.
  }
  return [...new Set(dirs)]
}

function firstExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate)
    if (isExistingFile(normalized)) {
      return normalized
    }
  }
  return null
}

/**
 * Find the scrcpy client belonging to the same install as `serverPath`.
 *
 * Probing it means executing a binary next to, or one prefix step above,
 * whatever SCRCPY_SERVER_PATH points at. That is a deliberate choice: the very
 * file it pairs with is about to be pushed to the device and executed there, so
 * the user already has to trust that install for a session to be possible at all.
 */
function clientForServer(serverPath: string): string | null {
  const candidates: string[] = []

  for (const dir of installDirsOf(serverPath)) {
    candidates.push(path.join(dir, clientFilename()))

    // <prefix>/share/scrcpy/scrcpy-server -> <prefix>/bin/scrcpy
    if (path.basename(dir) === "scrcpy" && path.basename(path.dirname(dir)) === "share") {
      candidates.push(path.join(dir, "..", "..", "bin", clientFilename()))
    }
  }

  return firstExistingFile(candidates)
}

/** Find the scrcpy-server belonging to the same install as `clientPath`. */
function serverForClient(clientPath: string): string | null {
  const candidates: string[] = []

  for (const dir of installDirsOf(clientPath)) {
    candidates.push(path.join(dir, SERVER_FILENAME))

    // <prefix>/bin/scrcpy -> <prefix>/share/scrcpy/scrcpy-server
    if (path.basename(dir) === "bin") {
      candidates.push(path.join(dir, "..", "share", "scrcpy", SERVER_FILENAME))
    }
  }

  return firstExistingFile(candidates)
}

// Asking the package manager where it put the server keeps discovery honest on
// hosts we have never seen: it reports the prefix that distribution actually
// chose instead of us enumerating the ones we happen to know. Only reached when
// neither SCRCPY_SERVER_PATH nor PATH resolved, so the cost is not paid in the
// common case. Windows has no equivalent, and needs none -- its installs are the
// portable archives that PATH discovery already covers.
const PACKAGE_QUERIES: ReadonlyArray<{
  command: string
  args: string[]
  map?: (line: string) => string
}> = [
  // Debian ships the jar in its own package, so ask for that one first.
  { command: "dpkg", args: ["-L", "scrcpy-server"] },
  { command: "dpkg", args: ["-L", "scrcpy"] },
  // "<pkg> <path>", and the path may itself contain spaces, so strip only
  // the package name rather than splitting the whole line on whitespace.
  { command: "pacman", args: ["-Ql", "scrcpy"], map: (line) => line.replace(/^\S+\s+/, "") },
  { command: "rpm", args: ["-ql", "scrcpy"] },
  { command: "apk", args: ["info", "-L", "scrcpy"] },
  {
    command: "brew",
    args: ["--prefix", "scrcpy"],
    map: (line) => path.join(line, "share", "scrcpy", SERVER_FILENAME),
  },
]

function serverFromPackageManager(): string | null {
  // None of these managers exist on Windows, so every query would be a spawn
  // that can only fail. Skipping them keeps the miss path cheap on the platform
  // the comment above already excludes.
  if (process.platform === "win32") {
    return null
  }

  for (const query of PACKAGE_QUERIES) {
    let output: string
    try {
      output = execFileSync(query.command, query.args, {
        encoding: "utf8",
        timeout: 5000,
        // A tool that does not know the package writes to stderr and exits
        // non-zero. That is an expected outcome of asking, not a fault worth
        // showing the user, so keep it out of the MCP server's log.
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      // Tool absent, or it does not know the package. Try the next one.
      continue
    }

    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue

      let candidate = query.map ? query.map(line) : line
      if (!candidate) continue
      // apk lists package contents relative to the filesystem root.
      if (!path.isAbsolute(candidate)) {
        candidate = path.join(path.sep, candidate)
      }

      if (path.basename(candidate) === SERVER_FILENAME && isExistingFile(candidate)) {
        return candidate
      }
    }
  }

  return null
}

export interface ScrcpyInstall {
  serverPath: string
  // The client that belongs to the same install, when one could be derived. It
  // is the only trustworthy source for the version of `serverPath`.
  clientPath: string | null
  // Which rung resolved the install: the SCRCPY_SERVER_PATH env var, the client
  // found on PATH, or a package manager's own records.
  origin: "env-path" | "path" | "package-manager"
}

/**
 * Resolve the scrcpy install to use, without memoization. Prefer
 * resolveScrcpyInstall() at call sites; this uncached form exists so the
 * resolution ladder can be unit-tested independently of the cache.
 *
 * Every rung yields a client/server *pair* anchored on one end. Resolving the
 * two separately is what let the reported version describe a different install
 * than the file being pushed, which the server rejects outright:
 * "The server version (3.3.4) does not match the client (1.25)".
 */
export function computeScrcpyInstall(): ScrcpyInstall | null {
  // Setting SCRCPY_SERVER_PATH is the user designating one specific install, so
  // that install's own client is the authority on its version -- even when some
  // other scrcpy comes first on PATH.
  const envPath = process.env.SCRCPY_SERVER_PATH
  if (envPath && isExistingFile(envPath)) {
    return { serverPath: envPath, clientPath: clientForServer(envPath), origin: "env-path" }
  }

  // Only one scrcpy on PATH can ever run, so the first match is unambiguous.
  // Deriving the server from it keeps the pair consistent.
  const clientOnPath = findScrcpyBinaryOnPath()
  if (clientOnPath) {
    const serverPath = serverForClient(clientOnPath)
    if (serverPath) {
      return { serverPath, clientPath: clientOnPath, origin: "path" }
    }
  }

  const packagedServer = serverFromPackageManager()
  if (packagedServer) {
    return {
      serverPath: packagedServer,
      clientPath: clientForServer(packagedServer),
      origin: "package-manager",
    }
  }

  return null
}

/**
 * Resolve the scrcpy-server path, without memoization. Prefer
 * findScrcpyServer() at call sites; this uncached form exists so the
 * resolution ladder can be unit-tested independently of the cache.
 */
export function computeScrcpyServerPath(): string | null {
  return computeScrcpyInstall()?.serverPath ?? null
}

// Only successful resolutions are cached. Caching the miss too would bound the
// cost identically, but it would also turn "install scrcpy and retry" into
// "install scrcpy and restart the MCP server", and a miss costs nothing to
// re-run beyond the failed lookup it already performed.
let cachedScrcpyInstall: ScrcpyInstall | null = null

/**
 * Resolve the scrcpy install. Memoized, so a single session start runs the
 * discovery commands once and every caller sees the same client/server pair.
 */
export function resolveScrcpyInstall(): ScrcpyInstall | null {
  if (!cachedScrcpyInstall) {
    cachedScrcpyInstall = computeScrcpyInstall()
  }
  return cachedScrcpyInstall
}

/** Resolve the scrcpy-server path to push. Memoized via resolveScrcpyInstall(). */
export function findScrcpyServer(): string | null {
  return resolveScrcpyInstall()?.serverPath ?? null
}

// Memoized: the version cannot change mid-process, and the uncached form runs
// a blocking execFileSync per call. Caching also guarantees every caller in a
// session start sees the same version, so the server launch args and the
// client's protocol expectations can never disagree.
let cachedScrcpyVersion: DetectedVersion | null = null

export interface DetectedVersion {
  version: string
  // Where the version was resolved from: the SCRCPY_SERVER_VERSION env var, the
  // client paired with the server that SCRCPY_SERVER_PATH names, the client
  // found on PATH, the client of a package-manager-reported install, or the
  // built-in default constant.
  source: "env" | "binary" | "server-sibling" | "package-manager" | "default"
}

// Which rung anchored the install, expressed as the version's provenance. The
// names predate the pairing rework and are kept so the `version` tool's output
// stays stable for existing users.
const VERSION_SOURCE_BY_ORIGIN: Record<ScrcpyInstall["origin"], DetectedVersion["source"]> = {
  "env-path": "server-sibling",
  path: "binary",
  "package-manager": "package-manager",
}

function probeScrcpyBinaryVersion(binary: string): string | null {
  try {
    const output = execFileSync(binary, ["--version"], {
      timeout: 5000,
      encoding: "utf8",
    })
    // Output format: "scrcpy 2.7 <https://github.com/Genymobile/scrcpy>"
    // or: "scrcpy 1.25 <https://github.com/Genymobile/scrcpy>"
    const match = output.match(/scrcpy\s+(\d+\.\d+(?:\.\d+)?)/)
    return match ? match[1] : null
  } catch {
    // Binary missing or not executable
    return null
  }
}

/**
 * Resolve the scrcpy version and where it came from, without memoization.
 * Prefer detectScrcpyVersionInfo() at call sites; this uncached form exists
 * so the resolution ladder can be unit-tested independently of the cache.
 */
export function computeScrcpyVersionInfo(): DetectedVersion {
  // An explicit override, and independent of which install is found.
  const envVersion = process.env.SCRCPY_SERVER_VERSION
  if (envVersion) {
    return { version: envVersion, source: "env" }
  }

  // Ask the client that belongs to the very server we are about to push, rather
  // than whatever scrcpy answers first on PATH.
  const install = resolveScrcpyInstall()
  if (install?.clientPath) {
    const version = probeScrcpyBinaryVersion(install.clientPath)
    if (version) {
      return { version, source: VERSION_SOURCE_BY_ORIGIN[install.origin] }
    }
  }

  console.error(
    `[scrcpy] Warning: could not detect scrcpy version -- no scrcpy client was ` +
      `found for the resolved scrcpy-server, and SCRCPY_SERVER_VERSION is not ` +
      `set; falling back to default ${SCRCPY_SERVER_VERSION}. Set ` +
      `SCRCPY_SERVER_VERSION if the installed server version differs.`
  )
  return { version: SCRCPY_SERVER_VERSION, source: "default" }
}

/**
 * Detect the installed scrcpy version and its source. Memoized: the version
 * cannot change mid-process, so every caller sees a single consistent result
 * and the `source` can never disagree with the `version` it accompanies.
 */
export function detectScrcpyVersionInfo(): DetectedVersion {
  if (!cachedScrcpyVersion) {
    cachedScrcpyVersion = computeScrcpyVersionInfo()
  }
  return cachedScrcpyVersion
}

/**
 * Detect the installed scrcpy version string. Falls back to the
 * SCRCPY_SERVER_VERSION constant if detection fails.
 */
export function detectScrcpyVersion(): string {
  return detectScrcpyVersionInfo().version
}

/**
 * Test-only: clear the memoized install and version so the ladders can be
 * exercised fresh without depending on call order across test files. Both are
 * cleared together because the version ladder resolves the install.
 */
export function __resetScrcpyDetectionCachesForTests(): void {
  cachedScrcpyVersion = null
  cachedScrcpyInstall = null
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

function parseVersion(version: string): ParsedVersion {
  const parts = version.split(".").map(Number)
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
  }
}

function isVersionAtLeast(
  version: string,
  minMajor: number,
  minMinor: number,
  minPatch: number
): boolean {
  const v = parseVersion(version)
  if (v.major !== minMajor) return v.major > minMajor
  if (v.minor !== minMinor) return v.minor > minMinor
  return v.patch >= minPatch
}

function generateScid(): number {
  // Generate a random 31-bit positive integer (scrcpy uses hex format)
  return Math.floor(Math.random() * 0x7FFFFFFF) + 1
}

function getSocketName(scid: number): string {
  if (scid === -1) {
    return "scrcpy"
  }
  return `scrcpy_${scid.toString(16).padStart(8, "0")}`
}

export async function pushScrcpyServer(serial: string, serverPath: string): Promise<void> {
  await execAdb(["-s", serial, "push", serverPath, SCRCPY_SERVER_PATH_LOCAL], 30000)
}

export async function setupPortForwarding(
  serial: string,
  port: number,
  scid: number
): Promise<void> {
  const socketName = getSocketName(scid)
  await execAdb(
    ["-s", serial, "forward", `tcp:${port}`, `localabstract:${socketName}`]
  )
}

export async function removePortForwarding(serial: string, port: number): Promise<void> {
  try {
    await execAdb(["-s", serial, "forward", "--remove", `tcp:${port}`])
  } catch {
    // Ignore errors if forwarding doesn't exist
  }
}

// scrcpy 4.0 renamed send_codec_meta to send_stream_meta (whose header gains a
// 4-byte flags field, see V4_DEVICE_META_SIZE). All other send_* options kept
// their names and defaults, and the server ignores unknown options with a
// warning, so the arg lists differ only in that one flag. Exported for tests.
export function buildServerArgs(
  serial: string,
  scid: number,
  version: string,
  options: ScrcpySessionOptions = {}
): string[] {
  const {
    maxSize = 1024,
    maxFps = 30,
    videoBitRate = 8000000,
  } = options

  const streamMetaArg = isVersionAtLeast(version, 4, 0, 0)
    ? "send_stream_meta=true"
    : "send_codec_meta=true"

  return [
    "-s", serial, "shell",
    `CLASSPATH=${SCRCPY_SERVER_PATH_LOCAL}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    version,
    `scid=${scid.toString(16).padStart(8, "0")}`,
    `log_level=verbose`,
    `max_size=${maxSize}`,
    `max_fps=${maxFps}`,
    `video_bit_rate=${videoBitRate}`,
    "tunnel_forward=true",
    "control=true",
    "audio=false",
    "video=true",
    "cleanup=true",
    "power_off_on_close=false",
    "clipboard_autosync=true",
    "downsize_on_error=false",
    "send_device_meta=true",
    "send_frame_meta=false",
    "send_dummy_byte=true",
    streamMetaArg,
    "video_codec=h264",
  ]
}

// Cap on the retained server stderr tail. The adb child lives for the whole
// session and the server runs at log_level=verbose, so an uncapped buffer would
// grow without bound while only ever being read on connect failure. The errors
// worth surfacing (e.g. a version mismatch) are the last thing written before
// the server dies, so keeping the tail loses nothing.
const MAX_SERVER_STDERR_BYTES = 8192

export interface ServerExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface ScrcpyServerProcess {
  process: ChildProcess
  // Stderr emitted by the server process since spawn, truncated to the last
  // MAX_SERVER_STDERR_BYTES. Collected so it can be surfaced in
  // connection-timeout errors when the server exits immediately (e.g. due to a
  // version mismatch).
  stderr: string
  // Set once the adb child exits. The scrcpy server runs in the foreground of
  // that adb shell, so an exit before the client connects means the server died
  // (e.g. version mismatch) and no amount of retrying will reach it.
  exit: ServerExit | null
}

/**
 * Build the error for a session whose server never accepted a connection. Pure
 * so the diagnostics that matter here — the server's own stderr, and whether it
 * died rather than timed out — can be tested without standing up adb, port
 * forwarding, and sockets.
 */
export function formatConnectFailure(
  port: number,
  timeoutMs: number,
  server: Pick<ScrcpyServerProcess, "stderr" | "exit">
): string {
  const lines: string[] = []

  if (server.exit) {
    const how = server.exit.signal
      ? `signal ${server.exit.signal}`
      : `exit code ${server.exit.code}`
    lines.push(
      `The scrcpy server exited (${how}) before accepting a connection on port ${port}.`
    )
  } else {
    lines.push(
      `Failed to connect to scrcpy server on port ${port} within ${timeoutMs}ms`
    )
  }

  const serverStderr = server.stderr.trim()
  if (serverStderr) {
    lines.push(`Server stderr:\n${serverStderr}`)
  }

  return lines.join("\n")
}

export function startScrcpyServer(
  serial: string,
  scid: number,
  options: ScrcpySessionOptions = {}
): Promise<ScrcpyServerProcess> {
  const version = detectScrcpyVersion()
  console.error(`[scrcpy] Using scrcpy server version: ${version}`)
  const serverArgs = buildServerArgs(serial, scid, version, options)

  const child = spawn(ADB_PATH, serverArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  })

  // Retained as raw bytes so the cap is actually a byte cap and so a multi-byte
  // character straddling two chunks survives: decoding is deferred to the getter,
  // which sees the whole buffer at once.
  let stderrBuffer = Buffer.alloc(0)
  // Separate decoder for the live log lines, which are emitted per chunk and so
  // would otherwise mangle a character split across a chunk boundary.
  const stderrDecoder = new StringDecoder("utf8")
  let exitInfo: ServerExit | null = null

  child.once("exit", (code, signal) => {
    exitInfo = { code, signal }
  })

  if (child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      stderrBuffer = Buffer.concat([stderrBuffer, data])
      if (stderrBuffer.length > MAX_SERVER_STDERR_BYTES) {
        stderrBuffer = stderrBuffer.subarray(
          stderrBuffer.length - MAX_SERVER_STDERR_BYTES
        )
      }
      const msg = stderrDecoder.write(data).trim()
      if (msg) {
        console.error(`[scrcpy-server] ${msg}`)
      }
    })
  }

  return new Promise((resolve, reject) => {
    child.once("error", (err) => {
      reject(new Error(
        `Failed to start scrcpy server for ${serial}: ${err.message}`,
        { cause: err }
      ))
    })

    child.once("spawn", () => {
      child.unref()
      resolve({
        process: child,
        get stderr() { return stderrBuffer.toString("utf8") },
        get exit() { return exitInfo },
      })
    })
  })
}



// In forward tunnel mode, `adb forward` accepts TCP connections even when no
// server is listening behind the tunnel. To detect that the server is actually
// ready we read the dummy byte (sent by scrcpy with send_dummy_byte=true) after
// the TCP connection is established. If the read fails, the server is not ready.
const connectAndVerify = async (port: number, timeout = 10000): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`Connection timeout to port ${port}`))
    }, timeout)

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }

    socket.on("error", (err) => fail(
      new Error(`Socket error connecting to port ${port}`, { cause: err })
    ))

    socket.on("connect", () => {
      // TCP connected to the ADB tunnel. Now read the dummy byte to verify
      // the scrcpy server is actually listening behind the tunnel.
      socket.once("data", (chunk: Buffer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (chunk.length > 1) {
          socket.unshift(chunk.subarray(1))
        }
        // Pause so data is buffered until the caller attaches its own handlers
        socket.pause()
        resolve(socket)
      })

      socket.once("close", () => fail(
        new Error("Socket closed before dummy byte received")
      ))
    })
  })

const connectToServer = async (port: number, timeout = 10000): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Connection timeout to port ${port}`))
    }, timeout)

    socket.on("connect", () => {
      clearTimeout(timer)
      resolve(socket)
    })

    socket.on("error", (err) => {
      clearTimeout(timer)
      reject(new Error(`Socket error connecting to port ${port}`, { cause: err }))
    })
  })

interface DeviceMetaResult {
  width: number
  height: number
  overflow: Buffer
}

export interface VideoMetaLayout {
  metaSize: number
  widthOffset: number
  heightOffset: number
}

// Byte layout of the video-socket metadata header for a given server version.
// Exported for tests.
export function videoMetaLayout(version: string): VideoMetaLayout {
  if (isVersionAtLeast(version, 4, 0, 0)) {
    return {
      metaSize: V4_DEVICE_META_SIZE,
      widthOffset: V4_VIDEO_WIDTH_OFFSET,
      heightOffset: V4_VIDEO_HEIGHT_OFFSET,
    }
  }
  return {
    metaSize: DEVICE_META_SIZE,
    widthOffset: VIDEO_WIDTH_OFFSET,
    heightOffset: VIDEO_HEIGHT_OFFSET,
  }
}

const receiveDeviceMeta = async (
  socket: net.Socket,
  port: number,
  layout: VideoMetaLayout
): Promise<DeviceMetaResult> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("data", onData)
      socket.off("error", onError)
      reject(new Error(`Timeout waiting for device metadata on port ${port}`))
    }, 10000)

    let buffer = Buffer.alloc(0)

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])

      if (buffer.length >= layout.metaSize) {
        clearTimeout(timer)
        socket.off("data", onData)
        socket.off("error", onError)

        const deviceName = buffer
          .subarray(DEVICE_NAME_OFFSET, DEVICE_NAME_OFFSET + 64)
          .toString("utf8")
          .replace(/\0+$/, "")
        console.error(`[scrcpy] Device name: ${deviceName}`)

        const width = buffer.readUInt32BE(layout.widthOffset)
        const height = buffer.readUInt32BE(layout.heightOffset)
        console.error(`[scrcpy] Screen size: ${width}x${height}`)

        // Any bytes beyond the metadata are the start of the h264 stream
        const overflow = buffer.length > layout.metaSize
          ? Buffer.from(buffer.subarray(layout.metaSize))
          : Buffer.alloc(0)

        resolve({ width, height, overflow })
      }
    }

    const onError = (err: Error) => {
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("error", onError)
      reject(new Error(
        `Socket error receiving device metadata on port ${port}`,
        { cause: err }
      ))
    }

    socket.on("data", onData)
    socket.on("error", onError)
    // Resume the socket which was paused by connectAndVerify after the dummy byte
    socket.resume()
  })

export interface DeviceMessageHandlers {
  /** Called once per complete clipboard message, in arrival order. */
  onClipboard: (text: string) => void
  /** Called when the stream can no longer be framed; the buffer is dropped. */
  onError: (message: string) => void
}

/**
 * Parse whatever complete device messages `pending + chunk` contains, returning
 * the bytes left over — the head of a message whose tail has not arrived yet.
 *
 * Framing is the entire job here: messages are not aligned to TCP reads, so one
 * read can carry several messages, a fraction of one, or both. Each type is
 * therefore consumed by its own exact length, and a type that is recognised but
 * ignored still has to be measured, because the bytes after it are a real
 * message.
 *
 * Pure apart from the handlers, so those rules can be tested by feeding buffers
 * in rather than by driving a device.
 */
export function consumeDeviceMessages(
  pending: Buffer,
  chunk: Buffer,
  handlers: DeviceMessageHandlers
): Buffer {
  let buffer = Buffer.concat([pending, chunk])

  // One byte is enough to learn the type; each branch then waits for the rest of
  // its own message.
  while (buffer.length >= 1) {
    const msgType = buffer.readUInt8(0)

    if (msgType === DEVICE_MSG_TYPE_CLIPBOARD) {
      if (buffer.length < 5) break

      const textLength = buffer.readUInt32BE(1)

      if (textLength > MAX_CLIPBOARD_BYTES) {
        handlers.onError(
          `Clipboard payload too large: ${textLength} bytes ` +
            `(max ${MAX_CLIPBOARD_BYTES}), resetting buffer`
        )
        return Buffer.alloc(0)
      }

      if (buffer.length < 5 + textLength) break

      handlers.onClipboard(buffer.toString("utf8", 5, 5 + textLength))
      buffer = buffer.subarray(5 + textLength)
    } else if (msgType === DEVICE_MSG_TYPE_ACK_CLIPBOARD) {
      // The server acknowledges every SET_CLIPBOARD sent with a non-zero
      // sequence. setClipboardViaScrcpy is fire-and-forget, so the sequence is
      // of no use to us — but skipping the ack by its exact length is not
      // optional. Treating it as unparseable used to drop the whole buffer,
      // which discards any clipboard message that arrived in the same read.
      if (buffer.length < DEVICE_MSG_ACK_CLIPBOARD_SIZE) break

      buffer = buffer.subarray(DEVICE_MSG_ACK_CLIPBOARD_SIZE)
    } else {
      // Length is encoded per type, so an unrecognised type leaves nothing to
      // say where the next message starts. Dropping the buffer is the only
      // resync available.
      handlers.onError(`Unknown device message type: ${msgType}, resetting buffer`)
      return Buffer.alloc(0)
    }
  }

  return buffer
}

const startDeviceMessageHandler = (session: ScrcpySession): void => {
  if (!session.controlSocket) return

  // Annotated because Buffer.alloc infers the narrower Buffer<ArrayBuffer>,
  // which the parser's return type does not satisfy.
  let messageBuffer: Buffer = Buffer.alloc(0)

  session.controlSocket.on("data", (data: Buffer) => {
    messageBuffer = consumeDeviceMessages(messageBuffer, data, {
      onClipboard: (text) => {
        session.clipboardContent = text
      },
      onError: (message) => {
        console.error(`[scrcpy] [${session.serial}] ${message}`)
      },
    })
  })
}

export async function startSession(
  serial: string,
  options: ScrcpySessionOptions = {}
): Promise<ScrcpySession> {
  const serverPath = findScrcpyServer()
  if (!serverPath) {
    throw new Error(
      "scrcpy-server not found. Install scrcpy or set SCRCPY_SERVER_PATH environment variable."
    )
  }

  const s = await resolveSerial(serial)

  if (hasActiveSession(s)) {
    return sessions.get(s)!
  }

  await pushScrcpyServer(s, serverPath)

  const port = SCRCPY_SERVER_PORT
  const scid = generateScid()
  await setupPortForwarding(s, port, scid)

  let serverProcess: ScrcpyServerProcess
  try {
    serverProcess = await startScrcpyServer(s, scid, options)
  } catch (err) {
    await removePortForwarding(s, port)
    throw err
  }

  const version = detectScrcpyVersion()

  const connectTimeout = 10000
  const retryInterval = 100
  const deadline = Date.now() + connectTimeout
  let socket: net.Socket | null = null
  let lastError: Error | null = null

  // In forward tunnel mode, adb forward accepts TCP connections even when
  // the server hasn't created its LocalServerSocket yet. connectAndVerify
  // reads the dummy byte after TCP connect to confirm the server is live.
  // (scrcpy 4.x still sends the dummy byte; only the codec-meta header
  // layout differs, handled below via videoMetaLayout.)
  while (Date.now() < deadline) {
    try {
      socket = await connectAndVerify(port, 2000)
      break
    } catch (err) {
      lastError = err as Error
      // The adb child is gone, so the server it was running is gone too.
      // Retrying can only burn the rest of the timeout before reporting a
      // failure we already know about.
      if (serverProcess.exit) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, retryInterval))
    }
  }

  if (!socket) {
    try {
      await execAdbShell(s, `pkill -f scrcpy-server`)
    } catch {
      // Ignore if process doesn't exist
    }
    try {
      await removePortForwarding(s, port)
    } catch {
      // Ignore if forwarding doesn't exist
    }
    throw new Error(
      formatConnectFailure(port, connectTimeout, serverProcess),
      { cause: lastError }
    )
  }

  let session: ScrcpySession | null = null
  try {
    // In forward tunnel mode the server accepts sockets in order:
    // video, then control. It only sends device metadata AFTER all
    // sockets have been accepted. So we must connect both sockets
    // before attempting to read the metadata from the video socket.
    let controlSocket: net.Socket | null = null
    let lastControlError: Error | null = null
    const controlConnectDeadline = Date.now() + 5000
    while (Date.now() < controlConnectDeadline) {
      try {
        const remaining = controlConnectDeadline - Date.now()
        if (remaining <= 0) break
        controlSocket = await connectToServer(port, remaining)
        break
      } catch (err) {
        lastControlError = err as Error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    if (!controlSocket) {
      socket.destroy()
      throw new Error(
        `Failed to connect control socket on port ${port} for device ${s} within timeout`,
        { cause: lastControlError }
      )
    }

    // The native display resolution (from `wm size`) is the coordinate space
    // callers work in (matching ui_dump / ui_find_element / `input tap`), and
    // is independent of the video stream — read it up front so it is available
    // even if the video stream never comes up.
    let nativeSize: { width: number; height: number } | null = null
    try {
      nativeSize = await getScreenSize(s)
    } catch (err) {
      console.error(
        `[scrcpy] Could not read native size for ${s} via wm size:`,
        (err as Error).message
      )
    }

    // Now that both sockets are connected, the server will proceed
    // to send device metadata on the video socket. We must consume these
    // bytes off the socket regardless so the h264 stream isn't corrupted,
    // but the width/height here are the *downscaled encoder frame* size
    // (e.g. 576x1024 at max_size=1024), NOT the device's native resolution.
    // The header layout depends on the server version (see videoMetaLayout).
    //
    // If metadata never arrives (e.g. the device/emulator has no usable h264
    // encoder, as on CI's swiftshader emulator) we don't hard-fail the whole
    // session: control still works over the control socket, and screenshots
    // fall back to `adb screencap`. We degrade to a video-less session instead.
    let videoAvailable = true
    let frameSize: { width: number; height: number }
    let overflow: Buffer = Buffer.alloc(0)
    try {
      const meta = await receiveDeviceMeta(socket, port, videoMetaLayout(version))
      frameSize = { width: meta.width, height: meta.height }
      overflow = meta.overflow
    } catch (err) {
      videoAvailable = false
      // Without device metadata there is no encoder frame size; fall back to
      // the native size so coordinates map 1:1 (input helpers won't downscale).
      frameSize = nativeSize ?? { width: 0, height: 0 }
      console.error(
        `[scrcpy] Device metadata not received for ${s}; continuing without ` +
          `video (screenshots will use adb screencap):`,
        (err as Error).message
      )
      // The video socket is unusable for streaming now; stop reading from it.
      socket.destroy()
    }

    // Fall back to the frame size for native coords only if `wm size` failed
    // AND we have a real frame size; otherwise coordinates are 1:1 with frame.
    if (!nativeSize) {
      nativeSize = videoAvailable ? frameSize : { width: 0, height: 0 }
    }

    // The scrcpy touch protocol requires the touch message's screenSize to
    // EXACTLY equal the video frame size; a mismatch makes the server's
    // PositionMapper silently drop the event. But callers (and ui_dump /
    // ui_find_element / `input tap`) work in NATIVE display coordinates. So we
    // expose the native size as `screenSize` (the coordinate space callers
    // use) and keep the frame size as `frameSize`; the input helpers scale
    // native coords into frame space before sending. max_size preserves aspect
    // ratio, so this is a single uniform scale on both axes.
    console.error(
      `[scrcpy] Frame size ${frameSize.width}x${frameSize.height}, native size ` +
        `${nativeSize.width}x${nativeSize.height}` +
        (videoAvailable ? "" : " (video unavailable)")
    )

    session = {
      serial: s,
      scid,
      controlSocket,
      videoSocket: videoAvailable ? socket : null,
      videoProcess: null,
      frameBuffer: null,
      screenSize: nativeSize,
      frameSize,
      videoAvailable,
      clipboardContent: null,
      viewerProcess: null,
    }

    const currentSession = session
    sessions.set(s, currentSession)

    // Wait for the first video frame before considering the session ready.
    // This ensures the scrcpy server's Controller has received the
    // onNewVirtualDisplay callback (which sets up the PositionMapper for
    // touch coordinate mapping). Without this, touch events sent before the
    // PositionMapper is initialized are silently discarded by the server.
    if (videoAvailable) {
      try {
        await startVideoStream(currentSession, socket, overflow)
      } catch (err) {
        // If the video stream fails to produce a frame, the session is still
        // usable for non-vision tools (key events, text input, etc.)
        const msg = `[scrcpy] Video stream failed for ${s}, session partially ready:`
        console.error(msg, (err as Error).message)
      }
    }

    controlSocket.on("close", () => {
      currentSession.controlSocket = null
    })

    controlSocket.on("error", (err) => {
      console.error(`[scrcpy] Control socket error for ${s}:`, err.message)
      currentSession.controlSocket = null
    })

    startDeviceMessageHandler(currentSession)

    return currentSession
  } catch (err) {
    if (session) {
      sessions.delete(s)
    }
    socket.destroy()
    try {
      await execAdbShell(s, `pkill -f scrcpy-server`)
    } catch {
      // Ignore if process doesn't exist
    }
    await removePortForwarding(s, port)
    throw err
  }
}

export async function stopSession(serial: string): Promise<void> {
  const s = await resolveSerial(serial)
  const session = sessions.get(s)

  if (!session) {
    return
  }

  if (session.videoSocket) {
    session.videoSocket.destroy()
    session.videoSocket = null
  }

  if (session.controlSocket) {
    session.controlSocket.destroy()
    session.controlSocket = null
  }

  if (session.videoProcess) {
    session.videoProcess.kill()
    session.videoProcess = null
  }

  if (session.viewerProcess && !session.viewerProcess.killed) {
    session.viewerProcess.kill()
  }
  session.viewerProcess = null

  try {
    await execAdbShell(s, `pkill -f scrcpy-server`)
  } catch {
    // Ignore if process doesn't exist
  }

  await removePortForwarding(s, SCRCPY_SERVER_PORT)

  sessions.delete(s)
}
