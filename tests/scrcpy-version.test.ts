import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import {
  buildServerArgs,
  videoMetaLayout,
  computeScrcpyServerPath,
  findScrcpyServer,
  formatConnectFailure,
  computeScrcpyVersionInfo,
  detectScrcpyVersionInfo,
  detectScrcpyVersion,
  __resetScrcpyDetectionCachesForTests,
} from "../src/utils/scrcpy.js"
import {
  DEVICE_META_SIZE,
  VIDEO_WIDTH_OFFSET,
  VIDEO_HEIGHT_OFFSET,
  V4_DEVICE_META_SIZE,
  V4_VIDEO_WIDTH_OFFSET,
  V4_VIDEO_HEIGHT_OFFSET,
  SCRCPY_SERVER_VERSION,
} from "../src/utils/constants.js"

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>()
  return { ...actual, execFileSync: vi.fn() }
})

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return { ...actual, statSync: vi.fn() }
})

const execFileSyncMock = vi.mocked(execFileSync)
const statSyncMock = vi.mocked(fs.statSync)

// Discovery accepts a path only if it stats as a regular file, so tests declare
// which paths are files; everything else stats as a directory or throws ENOENT.
function mockFilesystem(files: string[], directories: string[] = []) {
  statSyncMock.mockImplementation(((p: fs.PathLike) => {
    const target = String(p)
    if (files.includes(target)) {
      return { isFile: () => true } as fs.Stats
    }
    if (directories.includes(target)) {
      return { isFile: () => false } as fs.Stats
    }
    throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), {
      code: "ENOENT",
    })
  }) as unknown as typeof fs.statSync)
}

// Discovery and the version ladder both shell out, so tests declare what each
// command produces; anything unlisted fails the way a missing binary does.
function mockCommands(outputs: Record<string, string>) {
  execFileSyncMock.mockImplementation(((file: string) => {
    const output = outputs[file]
    if (output === undefined) {
      throw new Error(`command not found: ${file}`)
    }
    return output
  }) as unknown as typeof execFileSync)
}

// Built with path.join so the fixtures use the host separator, matching what
// discovery derives via path.dirname/path.join on any platform.
const binDir = path.join(path.sep, "opt", "scrcpy")
const scrcpyBinary = path.join(binDir, "scrcpy")
const windowsScrcpyBinary = path.join(binDir, "scrcpy.exe")
const siblingServer = path.join(binDir, "scrcpy-server")

// Both mocks replace module-wide functions, so reset them for every test in the
// file rather than per-describe. A stale implementation leaking across describe
// blocks surfaces as an unrelated test failing later, which is hard to trace.
// The memoized caches are cleared for the same reason.
beforeEach(() => {
  execFileSyncMock.mockReset()
  statSyncMock.mockReset()
  __resetScrcpyDetectionCachesForTests()
})

describe("buildServerArgs", () => {
  const commonWireFormatArgs = [
    "control=true",
    "cleanup=true",
    "send_device_meta=true",
    "send_frame_meta=false",
    "send_dummy_byte=true",
    "video_codec=h264",
  ]

  it("requests codec meta on scrcpy 3.x", () => {
    const args = buildServerArgs("SERIAL", 0x1234, "3.3.4")
    expect(args).toContain("send_codec_meta=true")
    expect(args).not.toContain("send_stream_meta=true")
  })

  it("requests stream meta on scrcpy 4.x (send_codec_meta was renamed)", () => {
    const args = buildServerArgs("SERIAL", 0x1234, "4.0")
    expect(args).toContain("send_stream_meta=true")
    expect(args).not.toContain("send_codec_meta=true")
  })

  it.each(["3.3.4", "4.0", "4.1.2"])(
    "pins the shared wire-format options explicitly for version %s",
    (version) => {
      const args = buildServerArgs("SERIAL", 0x1234, version)
      for (const arg of commonWireFormatArgs) {
        expect(args).toContain(arg)
      }
    }
  )

  it("applies session options for all versions", () => {
    for (const version of ["3.3.4", "4.0"]) {
      const args = buildServerArgs("SERIAL", 0x1234, version, {
        maxSize: 800,
        maxFps: 15,
        videoBitRate: 4000000,
      })
      expect(args).toContain("max_size=800")
      expect(args).toContain("max_fps=15")
      expect(args).toContain("video_bit_rate=4000000")
    }
  })
})

describe("videoMetaLayout", () => {
  it("uses the 76-byte header for scrcpy 3.x", () => {
    expect(videoMetaLayout("3.3.4")).toEqual({
      metaSize: DEVICE_META_SIZE,
      widthOffset: VIDEO_WIDTH_OFFSET,
      heightOffset: VIDEO_HEIGHT_OFFSET,
    })
  })

  it.each(["4.0", "4.0.1", "4.1", "5.0"])(
    "uses the 80-byte stream-meta header for version %s",
    (version) => {
      expect(videoMetaLayout(version)).toEqual({
        metaSize: V4_DEVICE_META_SIZE,
        widthOffset: V4_VIDEO_WIDTH_OFFSET,
        heightOffset: V4_VIDEO_HEIGHT_OFFSET,
      })
    }
  )

  it("treats pre-4.0 versions as legacy", () => {
    for (const version of ["1.25", "2.7", "3.9.9"]) {
      expect(videoMetaLayout(version).metaSize).toBe(DEVICE_META_SIZE)
    }
  })
})

describe("computeScrcpyServerPath", () => {
  const originalEnv = process.env.SCRCPY_SERVER_PATH

  beforeEach(() => {
    mockFilesystem([])
    delete process.env.SCRCPY_SERVER_PATH
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SCRCPY_SERVER_PATH
    } else {
      process.env.SCRCPY_SERVER_PATH = originalEnv
    }
  })

  it("returns SCRCPY_SERVER_PATH env var when present", () => {
    process.env.SCRCPY_SERVER_PATH = "/env/scrcpy-server"
    mockFilesystem(["/env/scrcpy-server"])
    expect(computeScrcpyServerPath()).toBe("/env/scrcpy-server")
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it("ignores SCRCPY_SERVER_PATH pointing at a directory", () => {
    // `adb push <dir>` would create the remote scrcpy-server.jar as a
    // directory, so a directory must not resolve as the server.
    process.env.SCRCPY_SERVER_PATH = "/env/scrcpy-dir"
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found")
    })
    mockFilesystem(["/usr/local/share/scrcpy/scrcpy-server"], ["/env/scrcpy-dir"])
    expect(computeScrcpyServerPath()).toBe("/usr/local/share/scrcpy/scrcpy-server")
  })

  it("discovers server next to scrcpy binary on PATH", () => {
    const lookupCommand = process.platform === "win32" ? "where" : "which"
    execFileSyncMock.mockReturnValue(`${scrcpyBinary}\n`)
    mockFilesystem([scrcpyBinary, siblingServer])
    expect(computeScrcpyServerPath()).toBe(siblingServer)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      lookupCommand,
      ["scrcpy"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 })
    )
  })

  it("looks the binary up with `where` on Windows", () => {
    // Only the lookup command is platform-branched; path handling comes from
    // node:path, which stays bound to the host platform even under this stub.
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    })
    try {
      // `where` emits CRLF, which the discovery code has to strip before the
      // path is usable — the original Windows report's root cause elsewhere.
      execFileSyncMock.mockReturnValue(`${scrcpyBinary}\r\n`)
      mockFilesystem([scrcpyBinary, siblingServer])
      expect(computeScrcpyServerPath()).toBe(siblingServer)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "where",
        ["scrcpy"],
        expect.objectContaining({ encoding: "utf8", timeout: 5000 })
      )
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      })
    }
  })

  it("skips PATH entries that are not files", () => {
    // `where` can report several matches; the first one that is a real file wins.
    const shadowed = path.join(path.sep, "opt", "shadow", "scrcpy")
    execFileSyncMock.mockReturnValue(`${shadowed}\n${scrcpyBinary}\n`)
    mockFilesystem([scrcpyBinary, siblingServer], [shadowed])
    expect(computeScrcpyServerPath()).toBe(siblingServer)
  })

  it("falls back to common Unix paths when PATH lookup fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found")
    })
    mockFilesystem(["/usr/local/share/scrcpy/scrcpy-server"])
    expect(computeScrcpyServerPath()).toBe("/usr/local/share/scrcpy/scrcpy-server")
  })

  it("returns null when no server is found", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found")
    })
    mockFilesystem([])
    expect(computeScrcpyServerPath()).toBeNull()
  })
})

describe("findScrcpyServer", () => {
  const originalEnv = process.env.SCRCPY_SERVER_PATH

  beforeEach(() => {
    delete process.env.SCRCPY_SERVER_PATH
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SCRCPY_SERVER_PATH
    } else {
      process.env.SCRCPY_SERVER_PATH = originalEnv
    }
  })

  it("memoizes a resolved path so the lookup runs once per process", () => {
    execFileSyncMock.mockReturnValue(`${scrcpyBinary}\n`)
    mockFilesystem([scrcpyBinary, siblingServer])

    expect(findScrcpyServer()).toBe(siblingServer)
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)

    // The version ladder derives from this path, so a second resolution must
    // not be able to hand a later caller a different answer.
    mockFilesystem([])
    expect(findScrcpyServer()).toBe(siblingServer)
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
  })

  it("retries after a miss so installing scrcpy needs no restart", () => {
    mockCommands({})
    mockFilesystem([])
    expect(findScrcpyServer()).toBeNull()

    execFileSyncMock.mockReturnValue(`${scrcpyBinary}\n`)
    mockFilesystem([scrcpyBinary, siblingServer])
    expect(findScrcpyServer()).toBe(siblingServer)
  })
})

describe("formatConnectFailure", () => {
  // The version-mismatch trace scrcpy's server writes to stderr before dying.
  const versionMismatch =
    "java.lang.IllegalArgumentException: The server version (4.1) " +
    "does not match the client (3.3.4)\n"

  it("reports a timeout when the server is still running", () => {
    const message = formatConnectFailure(27183, 10000, { stderr: "", exit: null })
    expect(message).toBe(
      "Failed to connect to scrcpy server on port 27183 within 10000ms"
    )
  })

  it("surfaces server stderr so the real cause is visible", () => {
    const message = formatConnectFailure(27183, 10000, {
      stderr: versionMismatch,
      exit: { code: 1, signal: null },
    })
    expect(message).toContain("does not match the client")
    expect(message).toContain("Server stderr:")
  })

  it("reports the exit rather than the timeout when the server died", () => {
    const message = formatConnectFailure(27183, 10000, {
      stderr: "",
      exit: { code: 1, signal: null },
    })
    expect(message).toContain("exited (exit code 1)")
    expect(message).not.toContain("within 10000ms")
  })

  it("names the signal when the server was killed", () => {
    const message = formatConnectFailure(27183, 10000, {
      stderr: "",
      exit: { code: null, signal: "SIGKILL" },
    })
    expect(message).toContain("exited (signal SIGKILL)")
  })

  it("omits the stderr section when the server said nothing", () => {
    const message = formatConnectFailure(27183, 10000, {
      stderr: "   \n  ",
      exit: null,
    })
    expect(message).not.toContain("Server stderr")
  })
})

describe("computeScrcpyVersionInfo", () => {
  const originalVersionEnv = process.env.SCRCPY_SERVER_VERSION
  const originalPathEnv = process.env.SCRCPY_SERVER_PATH

  beforeEach(() => {
    delete process.env.SCRCPY_SERVER_VERSION
    delete process.env.SCRCPY_SERVER_PATH
    mockFilesystem([])
  })

  afterEach(() => {
    if (originalVersionEnv === undefined) {
      delete process.env.SCRCPY_SERVER_VERSION
    } else {
      process.env.SCRCPY_SERVER_VERSION = originalVersionEnv
    }
    if (originalPathEnv === undefined) {
      delete process.env.SCRCPY_SERVER_PATH
    } else {
      process.env.SCRCPY_SERVER_PATH = originalPathEnv
    }
  })

  it("resolves from the SCRCPY_SERVER_VERSION env var without spawning the binary", () => {
    process.env.SCRCPY_SERVER_VERSION = "4.2"
    expect(computeScrcpyVersionInfo()).toEqual({ version: "4.2", source: "env" })
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it("resolves from the scrcpy binary when the env var is unset", () => {
    execFileSyncMock.mockReturnValue(
      "scrcpy 4.0 <https://github.com/Genymobile/scrcpy>\n"
    )
    expect(computeScrcpyVersionInfo()).toEqual({ version: "4.0", source: "binary" })
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "scrcpy",
      ["--version"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 })
    )
  })

  it("derives the version from the scrcpy binary next to the resolved server", () => {
    // The #51 scenario: an MCP process that never inherited the user's shell
    // PATH, worked around with SCRCPY_SERVER_PATH alone. `scrcpy --version` is
    // unreachable, so the version has to come from the install the resolved
    // server actually belongs to.
    process.env.SCRCPY_SERVER_PATH = siblingServer
    mockFilesystem([siblingServer, scrcpyBinary])
    mockCommands({ [scrcpyBinary]: "scrcpy 4.1 <https://github.com/Genymobile/scrcpy>\n" })

    expect(computeScrcpyVersionInfo()).toEqual({
      version: "4.1",
      source: "server-sibling",
    })
    expect(execFileSyncMock).toHaveBeenCalledWith(
      scrcpyBinary,
      ["--version"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 })
    )
  })

  it("probes scrcpy.exe next to the server on Windows", () => {
    // Only the binary name is platform-branched; path handling comes from
    // node:path, which stays bound to the host platform even under this stub.
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    })
    try {
      process.env.SCRCPY_SERVER_PATH = siblingServer
      mockFilesystem([siblingServer, windowsScrcpyBinary])
      mockCommands({
        [windowsScrcpyBinary]: "scrcpy 4.1 <https://github.com/Genymobile/scrcpy>\n",
      })

      expect(computeScrcpyVersionInfo()).toEqual({
        version: "4.1",
        source: "server-sibling",
      })
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      })
    }
  })

  it("prefers the binary on PATH over the server's sibling", () => {
    // Precedence is deliberate: the sibling rung only fires when the PATH probe
    // fails, so a reachable `scrcpy --version` still answers even when it
    // belongs to a different install than SCRCPY_SERVER_PATH points at.
    process.env.SCRCPY_SERVER_PATH = siblingServer
    mockFilesystem([siblingServer, scrcpyBinary])
    mockCommands({
      scrcpy: "scrcpy 4.1 <https://github.com/Genymobile/scrcpy>\n",
      [scrcpyBinary]: "scrcpy 3.3.4 <https://github.com/Genymobile/scrcpy>\n",
    })

    expect(computeScrcpyVersionInfo()).toEqual({ version: "4.1", source: "binary" })
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      scrcpyBinary,
      expect.anything(),
      expect.anything()
    )
  })

  it("falls back to the default when no scrcpy binary sits next to the server", () => {
    // A lone scrcpy-server downloaded from the releases page has no client
    // beside it: nothing to probe, and nothing spawned on a guessed path.
    const loneServer = path.join(path.sep, "downloads", "scrcpy-server")
    const loneSibling = path.join(path.sep, "downloads", "scrcpy")
    process.env.SCRCPY_SERVER_PATH = loneServer
    mockFilesystem([loneServer])
    mockCommands({})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    expect(computeScrcpyVersionInfo()).toEqual({
      version: SCRCPY_SERVER_VERSION,
      source: "default",
    })
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      loneSibling,
      expect.anything(),
      expect.anything()
    )
    consoleErrorSpy.mockRestore()
  })

  it("falls back to the default when the binary output does not match", () => {
    execFileSyncMock.mockReturnValue("not a scrcpy version line")
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(computeScrcpyVersionInfo()).toEqual({
      version: SCRCPY_SERVER_VERSION,
      source: "default",
    })
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not detect scrcpy version")
    )
    consoleErrorSpy.mockRestore()
  })

  it("falls back to the default when the binary is unavailable", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("command not found: scrcpy")
    })
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(computeScrcpyVersionInfo()).toEqual({
      version: SCRCPY_SERVER_VERSION,
      source: "default",
    })
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not detect scrcpy version")
    )
    consoleErrorSpy.mockRestore()
  })

  it("never reports a source that disagrees with its version", () => {
    // Regression guard: version and source must come from one resolution, so a
    // binary-derived version can never be labelled 'default' and vice versa.
    // Every rung is asserted, since a newly added rung is exactly where a
    // version and the label describing where it came from can drift apart.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      process.env.SCRCPY_SERVER_VERSION = "4.2"
      expect(computeScrcpyVersionInfo()).toEqual({ version: "4.2", source: "env" })

      delete process.env.SCRCPY_SERVER_VERSION
      mockCommands({ scrcpy: "scrcpy 3.3.4 <url>\n" })
      expect(computeScrcpyVersionInfo()).toEqual({ version: "3.3.4", source: "binary" })

      process.env.SCRCPY_SERVER_PATH = siblingServer
      mockFilesystem([siblingServer, scrcpyBinary])
      mockCommands({ [scrcpyBinary]: "scrcpy 4.1 <url>\n" })
      __resetScrcpyDetectionCachesForTests()
      expect(computeScrcpyVersionInfo()).toEqual({
        version: "4.1",
        source: "server-sibling",
      })

      delete process.env.SCRCPY_SERVER_PATH
      mockFilesystem([])
      mockCommands({})
      __resetScrcpyDetectionCachesForTests()
      expect(computeScrcpyVersionInfo()).toEqual({
        version: SCRCPY_SERVER_VERSION,
        source: "default",
      })
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })
})

describe("detectScrcpyVersionInfo", () => {
  it("memoizes the first resolution and keeps version/source consistent", () => {
    __resetScrcpyDetectionCachesForTests()
    const originalEnv = process.env.SCRCPY_SERVER_VERSION
    delete process.env.SCRCPY_SERVER_VERSION
    execFileSyncMock.mockReset()
    execFileSyncMock.mockReturnValue("scrcpy 4.0 <https://github.com/Genymobile/scrcpy>\n")

    try {
      const first = detectScrcpyVersionInfo()
      expect(first).toEqual({ version: "4.0", source: "binary" })
      expect(detectScrcpyVersion()).toBe(first.version)

      // Cache is now populated; a later resolution failure must not change it.
      execFileSyncMock.mockImplementation(() => {
        throw new Error("binary vanished")
      })
      expect(detectScrcpyVersionInfo()).toEqual(first)
      expect(detectScrcpyVersion()).toBe("4.0")
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SCRCPY_SERVER_VERSION
      } else {
        process.env.SCRCPY_SERVER_VERSION = originalEnv
      }
      __resetScrcpyDetectionCachesForTests()
    }
  })
})
