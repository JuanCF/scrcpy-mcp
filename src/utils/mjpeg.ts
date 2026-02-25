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

export async function startMjpegServer(serial: string, port: number): Promise<string> {
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

  // Wait for listen to succeed; reject immediately on bind error
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

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
      try { res.write(chunk) } catch (err) {
        console.error(`[mjpeg] Failed to write to client for ${serial}:`, err)
        clients.delete(res)
      }
    }
  }, FRAME_INTERVAL_MS)

  // Runtime error handler (after successful bind)
  server.on("error", (err) => {
    console.error(`[mjpeg] Server error for ${serial}:`, err)
    clearInterval(intervalId)
    for (const res of clients) {
      try { res.end() } catch (e) {
        console.error(`[mjpeg] Failed to end client for ${serial}:`, e)
      }
    }
    server.close((closeErr) => {
      if (closeErr) console.error(`[mjpeg] Failed to close server for ${serial}:`, closeErr)
    })
    servers.delete(serial)
  })

  servers.set(serial, { server, clients, intervalId, port })
  return `http://127.0.0.1:${port}`
}

export async function startMjpegViewer(
  serial: string, width: number, height: number, port: number
): Promise<boolean> {
  const session = getSession(serial)
  if (!session) return false

  if (session.viewerProcess && !session.viewerProcess.killed) {
    session.viewerProcess.kill()
  }
  session.viewerProcess = null
  session.viewerStdin = null

  return new Promise<boolean>((resolve) => {
    let settled = false

    const viewer = spawn("ffplay", [
      "-x", String(width),
      "-y", String(height),
      "-window_title", "scrcpy-mcp",
      "-loglevel", "quiet",
      `http://127.0.0.1:${port}`,
    ], { stdio: ["ignore", "ignore", "ignore"] })

    viewer.once("spawn", () => {
      session.viewerProcess = viewer
      settled = true
      resolve(true)
    })

    viewer.on("error", (err) => {
      console.error(`[mjpeg] ffplay error for ${serial}:`, err.message)
      if (session.viewerProcess === viewer) {
        session.viewerProcess = null
        session.viewerStdin = null
      }
      if (!settled) {
        settled = true
        resolve(false)
      }
    })

    viewer.on("exit", () => {
      if (session.viewerProcess === viewer) {
        session.viewerProcess = null
        session.viewerStdin = null
      }
    })
  })
}

export function stopMjpegServer(serial: string): boolean {
  const entry = servers.get(serial)
  if (!entry) return false
  clearInterval(entry.intervalId)
  for (const res of entry.clients) {
    try { res.end() } catch (err) {
      console.error(`[mjpeg] Failed to end client for ${serial}:`, err)
    }
  }
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
