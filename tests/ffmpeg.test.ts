import { describe, it, expect, afterEach } from "vitest"
import * as path from "path"
import { probeBinary } from "../src/utils/ffmpeg.js"

const originalFfplayPath = process.env.FFPLAY_PATH

afterEach(() => {
  if (originalFfplayPath === undefined) {
    delete process.env.FFPLAY_PATH
  } else {
    process.env.FFPLAY_PATH = originalFfplayPath
  }
})

describe("probeBinary", () => {
  // Regression: probeBinary used to statSync the bare command name, which
  // resolves against the process cwd. A host with ffplay installed on PATH was
  // reported as "ffplay was not found", making start_audio_stream unusable.
  it("resolves a bare command name through PATH", () => {
    process.env.FFPLAY_PATH = "sh"
    const resolved = probeBinary("ffplay")
    expect(resolved).not.toBeNull()
    expect(path.isAbsolute(resolved!)).toBe(true)
  })

  it("returns null for an absolute path that does not exist", () => {
    process.env.FFPLAY_PATH = "/nonexistent/dir/ffplay"
    expect(probeBinary("ffplay")).toBeNull()
  })

  it("returns null for a command that is not installed", () => {
    expect(probeBinary("scrcpy-mcp-definitely-not-installed")).toBeNull()
  })

  it("finds a binary that is on PATH by name", () => {
    const resolved = probeBinary("sh")
    expect(resolved).not.toBeNull()
    expect(path.isAbsolute(resolved!)).toBe(true)
  })
})
