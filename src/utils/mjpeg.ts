import http from "http"
import { spawn, execFile } from "child_process"
import { getLatestFrame, getSession } from "./scrcpy.js"

// On some X11 servers (notably virtual/VM displays), SDL2 picks a GLX-capable
// visual for every window it creates regardless of renderer, and that visual
// silently fails to map (the ffplay window never appears, stuck at the SDL
// placeholder title/size). Forcing SDL to use the server's actual default
// visual avoids that broken path. Resolved lazily once and cached; any
// failure (non-Linux, no DISPLAY, xdpyinfo missing) just skips the override.
let x11VisualIdPromise: Promise<string | null> | null = null

function resolveX11VisualId(): Promise<string | null> {
  if (!x11VisualIdPromise) {
    x11VisualIdPromise = new Promise((resolve) => {
      if (process.platform !== "linux" || !process.env.DISPLAY) {
        resolve(null)
        return
      }
      execFile("xdpyinfo", (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const match = stdout.match(/default visual id:\s*(0x[0-9a-fA-F]+)/)
        resolve(match ? String(parseInt(match[1], 16)) : null)
      })
    })
  }
  return x11VisualIdPromise
}

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

// Open a native viewer window by pointing ffplay at the MJPEG HTTP stream we
// already serve for this session. We deliberately do NOT launch the real scrcpy
// client here: this device allows only a single screen-capture/H.264 encoder
// session at a time, so a second scrcpy server would evict the MCP's own session
// and break input/screenshots. ffplay instead consumes the already-decoded JPEG
// frames over HTTP, so there is exactly one encoder on the device and many
// consumers (screenshots, MJPEG clients, this window). MJPEG also sidesteps the
// timestamp-less raw-H.264 problems that made ffplay stall before: each part is
// a complete JPEG, displayed the moment it arrives.
const findFfplay = (): string => process.env.FFPLAY_PATH || "ffplay"

export async function startStreamViewer(serial: string, url: string): Promise<boolean> {
  const session = getSession(serial)
  if (!session) return false

  if (session.viewerProcess && !session.viewerProcess.killed) {
    session.viewerProcess.kill()
  }
  session.viewerProcess = null

  // ffplay uses SDL, which can pick a broken default visual on virtual/VM X11
  // displays; reuse the resolved visual id if we have one.
  const visualId = await resolveX11VisualId()

  return new Promise<boolean>((resolve) => {
    let settled = false

    const viewer = spawn(findFfplay(), [
      "-window_title", "scrcpy-mcp",
      "-loglevel", "error",
      "-f", "mpjpeg",        // MIME multipart-JPEG demuxer (multipart/x-mixed-replace)
      "-fflags", "nobuffer", // low latency: don't buffer input
      "-flags", "low_delay",
      "-framedrop",          // drop late frames to stay current on a live stream
      url,
    ], {
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        ...(visualId ? { SDL_VIDEO_X11_VISUALID: visualId } : {}),
      },
    })

    viewer.once("spawn", () => {
      session.viewerProcess = viewer
      settled = true
      resolve(true)
    })

    viewer.on("error", (err) => {
      console.error(`[viewer] ffplay error for ${serial}:`, err.message)
      if (session.viewerProcess === viewer) {
        session.viewerProcess = null
      }
      if (!settled) {
        settled = true
        resolve(false)
      }
    })

    viewer.on("exit", () => {
      if (session.viewerProcess === viewer) {
        session.viewerProcess = null
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
  }

  servers.delete(serial)
  return true
}

export function isMjpegServerRunning(serial: string): boolean {
  return servers.has(serial)
}
