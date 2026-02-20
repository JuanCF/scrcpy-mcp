import { spawn, ChildProcess } from "child_process"
import * as net from "net"
import * as path from "path"
import * as fs from "fs"
import { execAdb, execAdbShell, resolveSerial } from "./adb.js"

const SCRCPY_SERVER_PORT = 27183
const SCRCPY_SERVER_PATH_LOCAL = "/data/local/tmp/scrcpy-server.jar"

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
  if (homeDir) {
    const commonPaths = [
      path.join(homeDir, ".local", "share", "scrcpy", "scrcpy-server"),
      "/usr/local/share/scrcpy/scrcpy-server",
      "/usr/share/scrcpy/scrcpy-server",
    ]

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p
      }
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
    "2.7",
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

  spawn("adb", serverArgs, {
    detached: true,
    stdio: "ignore",
  }).unref()
}

function readUint16BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt16BE(offset)
}

async function connectToServer(port: number, timeout = 10000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("Connection timeout"))
    }, timeout)

    socket.on("connect", () => {
      clearTimeout(timer)
      resolve(socket)
    })

    socket.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function receiveDeviceMeta(socket: net.Socket): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timeout waiting for device metadata"))
    }, 5000)

    let buffer = Buffer.alloc(0)

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])

      if (buffer.length >= 68) {
        clearTimeout(timer)
        socket.off("data", onData)

        const width = readUint16BE(buffer, 5)
        const height = readUint16BE(buffer, 7)
        
        resolve({ width, height })
      }
    }

    socket.on("data", onData)
    socket.on("error", reject)
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

  await startScrcpyServer(s, options)

  await new Promise((resolve) => setTimeout(resolve, 500))

  const socket = await connectToServer(port)

  const screenSize = await receiveDeviceMeta(socket)

  const session: ScrcpySession = {
    serial: s,
    controlSocket: socket,
    videoProcess: null,
    frameBuffer: null,
    screenSize,
  }

  sessions.set(s, session)

  socket.on("close", () => {
    session.controlSocket = null
  })

  socket.on("error", (err) => {
    console.error(`[scrcpy] Control socket error for ${s}:`, err.message)
    session.controlSocket = null
  })

  return session
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
