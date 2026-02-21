import { spawn, ChildProcess } from "child_process"
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
  buffer.writeInt32BE(metaState, offset)
  offset += 4
  buffer.writeInt32BE(repeat, offset)
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

export const CLIPBOARD_COPY_KEY_NONE = 0
export const CLIPBOARD_COPY_KEY_COPY = 1
export const CLIPBOARD_COPY_KEY_CUT = 2

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
  controlSocket: net.Socket | null
  videoSocket: net.Socket | null
  videoProcess: ChildProcess | null
  frameBuffer: Buffer | null
  screenSize: { width: number; height: number }
  clipboardContent: string | null
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
  return "ffmpeg"
}

function startVideoStream(session: ScrcpySession, videoSocket: net.Socket): void {
  const ffmpegPath = findFfmpeg()
  
  const ffmpeg = spawn(ffmpegPath, [
    "-f", "h264",
    "-i", "pipe:0",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", "5",
    "-vf", "fps=30",
    "pipe:1",
  ])

  session.videoProcess = ffmpeg
  session.videoSocket = videoSocket

  let jpegBuffer = Buffer.alloc(0)

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
      videoSocket.unpipe()
    })

    ffmpeg.stdin.on("close", () => {
      videoSocket.unpipe()
    })

    videoSocket.pipe(ffmpeg.stdin)
  }
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

export async function pushScrcpyServer(serial: string, serverPath: string): Promise<void> {
  await execAdb(["-s", serial, "push", serverPath, SCRCPY_SERVER_PATH_LOCAL], 30000)
}

export async function setupPortForwarding(serial: string, port: number): Promise<void> {
  await execAdb(["-s", serial, "forward", `tcp:${port}`, "localabstract:scrcpy"])
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
  options: ScrcpySessionOptions = {}
): Promise<void> {
  const {
    maxSize = 1024,
    maxFps = 30,
    videoBitRate = 8000000,
  } = options

  const serverArgs = [
    "-s", serial, "shell",
    `CLASSPATH=${SCRCPY_SERVER_PATH_LOCAL}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    SCRCPY_SERVER_VERSION,
    `log_level=debug`,
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
    "downsize_on_error=true",
    "send_device_meta=true",
    "send_frame_meta=false",
    "send_dummy_byte=true",
    "send_codec_meta=true",
    "video_codec=h264",
  ]

  return new Promise((resolve, reject) => {
    const child = spawn(ADB_PATH, serverArgs, {
      detached: true,
      stdio: "ignore",
    })

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

const readUint16BE = (buffer: Buffer, offset: number): number =>
  buffer.readUInt16BE(offset)

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

const receiveDeviceMeta = async (
  socket: net.Socket,
  port: number
): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("data", onData)
      socket.off("error", onError)
      reject(new Error(`Timeout waiting for device metadata on port ${port}`))
    }, 5000)

    let buffer = Buffer.alloc(0)

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])

      if (buffer.length >= 68) {
        clearTimeout(timer)
        socket.off("data", onData)
        socket.off("error", onError)

        const width = readUint16BE(buffer, 5)
        const height = readUint16BE(buffer, 7)
        
        resolve({ width, height })
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
  await setupPortForwarding(s, port)

  try {
    await startScrcpyServer(s, options)
  } catch (err) {
    await removePortForwarding(s, port)
    throw err
  }

  const connectTimeout = 10000
  const retryInterval = 100
  const deadline = Date.now() + connectTimeout
  let socket: net.Socket | null = null
  let lastError: Error | null = null

  while (Date.now() < deadline) {
    try {
      socket = await connectToServer(port)
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
    const screenSize = await receiveDeviceMeta(socket, port)

    session = {
      serial: s,
      controlSocket: null,
      videoSocket: socket,
      videoProcess: null,
      frameBuffer: null,
      screenSize,
      clipboardContent: null,
    }

    const currentSession = session
    sessions.set(s, currentSession)

    startVideoStream(currentSession, socket)

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
      if (currentSession.videoProcess) {
        currentSession.videoProcess.kill()
        currentSession.videoProcess = null
      }
      sessions.delete(s)
      throw new Error(
        `Failed to connect control socket on port ${port} for device ${s} within timeout`,
        { cause: lastControlError }
      )
    }

    currentSession.controlSocket = controlSocket

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

  try {
    await execAdbShell(s, `pkill -f scrcpy-server`)
  } catch {
    // Ignore if process doesn't exist
  }

  await removePortForwarding(s, SCRCPY_SERVER_PORT)

  sessions.delete(s)
}
