import http from "http"
import { spawn } from "child_process"
import { getLatestFrame, getSession } from "./scrcpy.js"

interface MjpegEntry {
  server: http.Server
  clients: Set<http.ServerResponse>
  intervalId: NodeJS.Timeout
  port: number
}

const servers = new Map<string, MjpegEntry>()
const BOUNDARY = "scrcpy_frame"
const FRAME_INTERVAL_MS = 33 // ~30 fps

export function startMjpegServer(serial: string, port: number): string {
  if (servers.has(serial)) stopMjpegServer(serial)

  const clients = new Set<http.ServerResponse>()

  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    })
    clients.add(res)
    res.on("close", () => clients.delete(res))
  })

  server.listen(port)

  let lastFrame: Buffer | null = null

  const intervalId = setInterval(() => {
    if (clients.size === 0) return
    const frame = getLatestFrame(serial)
    if (!frame || frame === lastFrame) return
    lastFrame = frame

    const header = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
    )
    const tail = Buffer.from("\r\n")
    const chunk = Buffer.concat([header, frame, tail])

    for (const res of clients) {
      try { res.write(chunk) } catch { clients.delete(res) }
    }
  }, FRAME_INTERVAL_MS)

  servers.set(serial, { server, clients, intervalId, port })
  return `http://localhost:${port}`
}

export function startMjpegViewer(serial: string, width: number, height: number): boolean {
  const session = getSession(serial)
  if (!session) return false

  if (session.viewerProcess && !session.viewerProcess.killed) {
    session.viewerProcess.kill()
  }
  session.viewerProcess = null
  session.viewerStdin = null

  try {
    // ffplay reads raw H.264 directly from stdin — no MJPEG re-encode needed.
    const viewer = spawn("ffplay", [
      "-x", String(width),
      "-y", String(height),
      "-window_title", "scrcpy-mcp",
      "-loglevel", "quiet",
      "-f", "h264",
      "-i", "pipe:0",
    ], { stdio: ["pipe", "ignore", "ignore"] })

    viewer.on("error", (err) => {
      console.error(`[mjpeg] ffplay error for ${serial}:`, err.message)
      session.viewerProcess = null
      session.viewerStdin = null
    })

    viewer.on("exit", () => {
      session.viewerProcess = null
      session.viewerStdin = null
    })

    // Replay buffered H.264 history so ffplay can find a keyframe (SPS+PPS+IDR)
    // even when connecting after the session has been running for a while.
    if (viewer.stdin && session.h264Buffer.length > 0) {
      viewer.stdin.write(session.h264Buffer)
    }
    session.viewerProcess = viewer
    session.viewerStdin = viewer.stdin
    return true
  } catch {
    return false
  }
}

export function stopMjpegServer(serial: string): boolean {
  const entry = servers.get(serial)
  if (!entry) return false
  clearInterval(entry.intervalId)
  for (const res of entry.clients) { try { res.end() } catch { /* ignore */ } }
  entry.server.close()

  const session = getSession(serial)
  if (session) {
    if (session.viewerProcess && !session.viewerProcess.killed) {
      session.viewerProcess.kill()
    }
    session.viewerProcess = null
    session.viewerStdin = null
  }

  servers.delete(serial)
  return true
}

export function isMjpegServerRunning(serial: string): boolean {
  return servers.has(serial)
}
