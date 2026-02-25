import { spawn, execSync, ChildProcess } from "child_process"
import { createRequire } from "module"
import * as net from "net"
import * as path from "path"
import * as fs from "fs"
import { execAdb, execAdbShell, resolveSerial } from "./adb.js"
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
  MAX_CLIPBOARD_BYTES,
  CLIPBOARD_COPY_KEY_NONE,
  DEVICE_META_SIZE,
  DEVICE_NAME_OFFSET,
  VIDEO_WIDTH_OFFSET,
  VIDEO_HEIGHT_OFFSET,
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
  screenSize: { width: number; height: number }
  clipboardContent: string | null
  viewerProcess: ChildProcess | null
  viewerStdin: NodeJS.WritableStream | null
  h264Buffer: Buffer  // rolling buffer for late viewer connections
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
    if (ffmpegStatic) return ffmpegStatic
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
  let rejectFirstFrame: ((err: Error) => void) | null = null

  const firstFramePromise = new Promise<void>((resolve, reject) => {
    resolveFirstFrame = resolve
    rejectFirstFrame = reject
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

  ffmpeg.on("error", (err: Error) => {
    console.error(`[scrcpy] ffmpeg error for ${session.serial}:`, err.message)
    if (session.videoSocket) {
      session.videoSocket.destroy()
      session.videoSocket = null
    }
    session.frameBuffer = null
    session.videoProcess = null
    if (!firstFrameReceived) {
      firstFrameReceived = true
      clearTimeout(firstFrameTimeout)
      rejectFirstFrame?.(err)
    }
  })

  ffmpeg.on("exit", (code: number | null) => {
    session.videoProcess = null
    if (code !== 0 && code !== null) {
      console.error(`[scrcpy] ffmpeg exited with code ${code} for ${session.serial}`)
      if (session.videoSocket) {
        session.videoSocket.destroy()
        session.videoSocket = null
      }
      session.frameBuffer = null
      if (!firstFrameReceived) {
        firstFrameReceived = true
        clearTimeout(firstFrameTimeout)
        rejectFirstFrame?.(new Error(`ffmpeg exited with code ${code}`))
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

    // Tee the raw H.264 stream: ffmpeg (for JPEG frame extraction / screenshots)
    // and optionally the viewer process stdin (raw H.264, no re-encode needed).
    // A rolling buffer of recent H.264 data is kept so that a viewer that connects
    // after session start can receive enough history to include a full keyframe
    // (SPS+PPS+IDR), allowing it to start decoding immediately.
    const MAX_H264_BUFFER = 2 * 1024 * 1024 // 2 MB ≈ 2s at 8Mbps

    // Write any overflow bytes from the metadata read before starting the tee,
    // and include them in the rolling H.264 history (they carry SPS/PPS/IDR data).
    if (initialData && initialData.length > 0) {
      ffmpeg.stdin.write(initialData)
      session.h264Buffer = Buffer.concat([session.h264Buffer, initialData])
      if (session.h264Buffer.length > MAX_H264_BUFFER) {
        session.h264Buffer = session.h264Buffer.subarray(
          session.h264Buffer.length - MAX_H264_BUFFER
        )
      }
    }
    videoSocket.on("data", (chunk: Buffer) => {
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        try { ffmpeg.stdin.write(chunk) } catch { /* EPIPE handled above */ }
      }
      // Update rolling H.264 buffer
      session.h264Buffer = Buffer.concat([session.h264Buffer, chunk])
      if (session.h264Buffer.length > MAX_H264_BUFFER) {
        session.h264Buffer = session.h264Buffer.subarray(
          session.h264Buffer.length - MAX_H264_BUFFER
        )
      }
      if (session.viewerStdin) {
        const vs = session.viewerStdin as NodeJS.WritableStream & { destroyed?: boolean }
        if (!vs.destroyed) {
          try { vs.write(chunk) } catch {
            session.viewerStdin = null
          }
        }
      }
    })
  }

  return firstFramePromise
}

export function findScrcpyServer(): string | null {
  const envPath = process.env.SCRCPY_SERVER_PATH
  if (envPath && fs.existsSync(envPath)) {
    return envPath
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE
  const commonPaths: string[] = [
    "/usr/local/share/scrcpy/scrcpy-server",
    "/usr/share/scrcpy/scrcpy-server",
  ]

  if (homeDir) {
    commonPaths.unshift(path.join(homeDir, ".local", "share", "scrcpy", "scrcpy-server"))
  }

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p
    }
  }

  return null
}

/**
 * Detect the installed scrcpy version by running `scrcpy --version`.
 * Falls back to the SCRCPY_SERVER_VERSION constant if detection fails.
 */
export function detectScrcpyVersion(): string {
  const envVersion = process.env.SCRCPY_SERVER_VERSION
  if (envVersion) {
    return envVersion
  }

  try {
    const output = execSync("scrcpy --version 2>/dev/null", {
      timeout: 5000,
      encoding: "utf8",
    })
    // Output format: "scrcpy 2.7 <https://github.com/Genymobile/scrcpy>"
    // or: "scrcpy 1.25 <https://github.com/Genymobile/scrcpy>"
    const match = output.match(/scrcpy\s+(\d+\.\d+(?:\.\d+)?)/)
    if (match) {
      return match[1]
    }
  } catch {
    // scrcpy CLI not available, fall through
  }

  return SCRCPY_SERVER_VERSION
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

export async function startScrcpyServer(
  serial: string,
  scid: number,
  options: ScrcpySessionOptions = {}
): Promise<void> {
  const {
    maxSize = 1024,
    maxFps = 30,
    videoBitRate = 8000000,
  } = options

  const version = detectScrcpyVersion()
  console.error(`[scrcpy] Using scrcpy server version: ${version}`)

  const serverArgs = [
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
    "send_codec_meta=true",
    "video_codec=h264",
  ]

  return new Promise((resolve, reject) => {
    const child = spawn(ADB_PATH, serverArgs, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    })

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const msg = data.toString().trim()
        if (msg) {
          console.error(`[scrcpy-server] ${msg}`)
        }
      })
    }

    child.once("error", (err) => {
      reject(new Error(
        `Failed to start scrcpy server for ${serial}: ${err.message}`,
        { cause: err }
      ))
    })

    child.once("spawn", () => {
      child.unref()
      resolve()
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

const receiveDeviceMeta = async (
  socket: net.Socket,
  port: number
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

      if (buffer.length >= DEVICE_META_SIZE) {
        clearTimeout(timer)
        socket.off("data", onData)
        socket.off("error", onError)

        const deviceName = buffer
          .subarray(DEVICE_NAME_OFFSET, DEVICE_NAME_OFFSET + 64)
          .toString("utf8")
          .replace(/\0+$/, "")
        console.error(`[scrcpy] Device name: ${deviceName}`)

        const width = buffer.readUInt32BE(VIDEO_WIDTH_OFFSET)
        const height = buffer.readUInt32BE(VIDEO_HEIGHT_OFFSET)
        console.error(`[scrcpy] Screen size: ${width}x${height}`)

        // Any bytes beyond the metadata are the start of the h264 stream
        const overflow = buffer.length > DEVICE_META_SIZE
          ? Buffer.from(buffer.subarray(DEVICE_META_SIZE))
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

const startDeviceMessageHandler = (session: ScrcpySession): void => {
  if (!session.controlSocket) return

  let messageBuffer = Buffer.alloc(0)

  session.controlSocket.on("data", (data: Buffer) => {
    messageBuffer = Buffer.concat([messageBuffer, data])

    while (messageBuffer.length >= 5) {
      const msgType = messageBuffer.readUInt8(0)

      if (msgType === DEVICE_MSG_TYPE_CLIPBOARD) {
        const textLength = messageBuffer.readUInt32BE(1)

        if (textLength > MAX_CLIPBOARD_BYTES) {
          console.error(
            `[scrcpy] [${session.serial}] Clipboard payload too large: ` +
              `${textLength} bytes (max ${MAX_CLIPBOARD_BYTES}), resetting buffer`
          )
          messageBuffer = Buffer.alloc(0)
          break
        }

        if (messageBuffer.length < 5 + textLength) break

        const text = messageBuffer.toString("utf8", 5, 5 + textLength)
        session.clipboardContent = text

        messageBuffer = messageBuffer.subarray(5 + textLength)
      } else {
        console.error(
          `[scrcpy] [${session.serial}] Unknown device message type: ${msgType}, resetting buffer`
        )
        messageBuffer = Buffer.alloc(0)
      }
    }
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

  try {
    await startScrcpyServer(s, scid, options)
  } catch (err) {
    await removePortForwarding(s, port)
    throw err
  }

  const connectTimeout = 10000
  const retryInterval = 100
  const deadline = Date.now() + connectTimeout
  let socket: net.Socket | null = null
  let lastError: Error | null = null

  // In forward tunnel mode, adb forward accepts TCP connections even when
  // the server hasn't created its LocalServerSocket yet. connectAndVerify
  // reads the dummy byte after TCP connect to confirm the server is live.
  while (Date.now() < deadline) {
    try {
      socket = await connectAndVerify(port, 2000)
      break
    } catch (err) {
      lastError = err as Error
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
      `Failed to connect to scrcpy server on port ${port} within ${connectTimeout}ms`,
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

    // Now that both sockets are connected, the server will proceed
    // to send device metadata on the video socket.
    const { width, height, overflow } = await receiveDeviceMeta(socket, port)

    session = {
      serial: s,
      scid,
      controlSocket,
      videoSocket: socket,
      videoProcess: null,
      frameBuffer: null,
      screenSize: { width, height },
      clipboardContent: null,
      viewerProcess: null,
      viewerStdin: null,
      h264Buffer: Buffer.alloc(0),
    }

    const currentSession = session
    sessions.set(s, currentSession)

    // Wait for the first video frame before considering the session ready.
    // This ensures the scrcpy server's Controller has received the
    // onNewVirtualDisplay callback (which sets up the PositionMapper for
    // touch coordinate mapping). Without this, touch events sent before the
    // PositionMapper is initialized are silently discarded by the server.
    try {
      await startVideoStream(currentSession, socket, overflow)
    } catch (err) {
      // If the video stream fails to produce a frame, the session is still
      // usable for non-vision tools (key events, text input, etc.)
      const msg = `[scrcpy] Video stream failed for ${s}, session partially ready:`
      console.error(msg, (err as Error).message)
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
  session.viewerStdin = null

  try {
    await execAdbShell(s, `pkill -f scrcpy-server`)
  } catch {
    // Ignore if process doesn't exist
  }

  await removePortForwarding(s, SCRCPY_SERVER_PORT)

  sessions.delete(s)
}
