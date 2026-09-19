import { execFileSync } from "child_process"
import { createRequire } from "module"
import * as fs from "fs"

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

export function findFfmpeg(): string {
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

export function findFfplay(): string {
  return process.env.FFPLAY_PATH || "ffplay"
}

// findFfmpeg/findFfplay fall back to the bare command name, which is spawned
// through PATH. statSync on a bare name resolves against the process cwd, so
// asking PATH is the only way to tell "installed system-wide" apart from
// "missing" — without this, a host with /usr/bin/ffplay reports it as absent.
function findOnPath(name: string): string | null {
  const command = process.platform === "win32" ? "where" : "which"
  try {
    const output = execFileSync(command, [name], {
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
    // binary not on PATH or lookup failed
  }
  return null
}

function resolveBinary(resolved: string): string | null {
  if (resolved.includes("/") || resolved.includes("\\")) {
    return isExistingFile(resolved) ? resolved : null
  }
  return findOnPath(resolved)
}

/**
 * Verify that an audio/video helper binary can be reached. Returns the resolved
 * path if it exists, otherwise null. Used to give callers a clear message before
 * they try to spawn a binary that is not installed.
 */
export function probeBinary(name: string): string | null {
  if (name === "ffmpeg") {
    return resolveBinary(findFfmpeg())
  }
  if (name === "ffplay") {
    return resolveBinary(findFfplay())
  }
  return findOnPath(name)
}
