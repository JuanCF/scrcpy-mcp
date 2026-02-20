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
} from "./constants.js"

export interface ScrcpySessionOptions {
  maxSize?: number
  maxFps?: number
  videoBitRate?: number
}

export interface ScrcpySession {
  serial: string
  controlSocket: net.Socket | null
  videoProcess: ChildProcess | null
  frameBuffer: Buffer | null
  screenSize: { width: number; height: number }
}

const sessions: Map<string, ScrcpySession> = new Map()

export function getSession(serial: string): ScrcpySession | undefined {
  return sessions.get(serial)
}

export function hasActiveSession(serial: string): boolean {
  const session = sessions.get(serial)
  return session !== undefined && session.controlSocket !== null && !session.controlSocket.destroyed
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
      reject(new Error(`Socket error while receiving device metadata on port ${port}`, { cause: err }))
    }

    socket.on("data", onData)
    socket.on("error", onError)
  })

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
      controlSocket: socket,
      videoProcess: null,
      frameBuffer: null,
      screenSize,
    }

    sessions.set(s, session)

    socket.on("close", () => {
      session!.controlSocket = null
    })

    socket.on("error", (err) => {
      console.error(`[scrcpy] Control socket error for ${s}:`, err.message)
      session!.controlSocket = null
    })

    return session
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
