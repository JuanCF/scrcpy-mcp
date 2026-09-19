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

/**
 * Verify that an audio/video helper binary can be reached. Returns the resolved
 * path if it exists, otherwise null. Used to give callers a clear message before
 * they try to spawn a binary that is not installed.
 */
export function probeBinary(name: string): string | null {
  if (name === "ffmpeg") {
    const resolved = findFfmpeg()
    return isExistingFile(resolved) ? resolved : null
  }
  if (name === "ffplay") {
    const resolved = findFfplay()
    return isExistingFile(resolved) ? resolved : null
  }
  try {
    execFileSync("which", [name], { stdio: "ignore" })
    return name
  } catch {
    return null
  }
}
