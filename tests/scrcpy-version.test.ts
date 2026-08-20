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
  return { ...actual, statSync: vi.fn(), realpathSync: vi.fn() }
})

const execFileSyncMock = vi.mocked(execFileSync)
const statSyncMock = vi.mocked(fs.statSync)
const realpathSyncMock = vi.mocked(fs.realpathSync)

// Derivation resolves a path before deriving its counterpart, so symlink farms
// (Homebrew's bin/scrcpy -> Cellar/scrcpy/<v>/bin/scrcpy) land on the install
// rather than the link. Tests declare only the links they care about; every
// other path resolves to itself. Links are applied to whole path components,
// the way realpath does, so declaring a directory link also rewrites the paths
// beneath it -- otherwise a test could pass against a leaf-only lookup that the
// real filesystem would have resolved.
function mockSymlinks(links: Record<string, string> = {}) {
  realpathSyncMock.mockImplementation(((p: fs.PathLike) => {
    let target = String(p)
    for (const [link, destination] of Object.entries(links)) {
      if (target === link) {
        target = destination
      } else if (target.startsWith(link + path.sep)) {
        target = path.join(destination, target.slice(link.length + 1))
      }
    }
    return target
  }) as unknown as typeof fs.realpathSync)
}

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
// Keys may be the bare command ("scrcpy") or the full invocation
// ("dpkg -L scrcpy-server"), because the package-manager rung asks one tool
// several different questions and each must be able to answer differently.
function mockCommands(outputs: Record<string, string>) {
  execFileSyncMock.mockImplementation(((file: string, args?: string[]) => {
    const invocation = [file, ...(args ?? [])].join(" ")
    const output = outputs[invocation] ?? outputs[file]
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

// A prefix install (ninja install, install_release.sh, distro packages) never
// puts the two files in one directory: the client lands in <prefix>/bin and the
// server in <prefix>/share/scrcpy. Two prefixes, so tests can put a client in
// one and a server in the other and assert they are never crossed.
const prefix = path.join(path.sep, "usr", "local")
const prefixClient = path.join(prefix, "bin", "scrcpy")
const prefixServer = path.join(prefix, "share", "scrcpy", "scrcpy-server")
const otherPrefix = path.join(path.sep, "usr")
const otherPrefixClient = path.join(otherPrefix, "bin", "scrcpy")
const otherPrefixServer = path.join(otherPrefix, "share", "scrcpy", "scrcpy-server")

// Both mocks replace module-wide functions, so reset them for every test in the
// file rather than per-describe. A stale implementation leaking across describe
// blocks surfaces as an unrelated test failing later, which is hard to trace.
// The memoized caches are cleared for the same reason.
beforeEach(() => {
  execFileSyncMock.mockReset()
  statSyncMock.mockReset()
  realpathSyncMock.mockReset()
  mockSymlinks()
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
    mockCommands({ which: `${scrcpyBinary}\n`, where: `${scrcpyBinary}\n` })
    mockFilesystem([scrcpyBinary, siblingServer], ["/env/scrcpy-dir"])
    expect(computeScrcpyServerPath()).toBe(siblingServer)
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

  it("derives the server from the PATH client's prefix", () => {
    // A prefix install has no server beside the client, so discovery has to
    // follow <prefix>/bin -> <prefix>/share/scrcpy. Without this the client and
    // the server come from unrelated ladders and can describe different installs.
    mockCommands({ which: `${prefixClient}\n`, where: `${prefixClient}\n` })
    mockFilesystem([prefixClient, prefixServer])
    expect(computeScrcpyServerPath()).toBe(prefixServer)
  })

  it("never crosses two installs when both are present", () => {
    // The #56 failure, reachable with no environment variable set at all: the
    // client that PATH resolves must bring its own server, not the other one.
    mockCommands({ which: `${otherPrefixClient}\n`, where: `${otherPrefixClient}\n` })
    mockFilesystem([prefixClient, prefixServer, otherPrefixClient, otherPrefixServer])
    expect(computeScrcpyServerPath()).toBe(otherPrefixServer)
  })

  it("resolves a symlinked client to the install it points at", () => {
    // Homebrew's bin/ is a link farm; deriving from the link's own directory
    // would look for the server under the farm instead of the Cellar.
    const linked = path.join(path.sep, "opt", "homebrew", "bin", "scrcpy")
    const cellar = path.join(path.sep, "opt", "homebrew", "Cellar", "scrcpy", "4.1")
    const cellarClient = path.join(cellar, "bin", "scrcpy")
    const cellarServer = path.join(cellar, "share", "scrcpy", "scrcpy-server")
    mockCommands({ which: `${linked}\n`, where: `${linked}\n` })
    mockFilesystem([linked, cellarClient, cellarServer])
    mockSymlinks({ [path.dirname(linked)]: path.dirname(cellarClient) })
    expect(computeScrcpyServerPath()).toBe(cellarServer)
  })

  it("resolves a client that is itself the symlink", () => {
    // The shape Homebrew actually installs: bin/ is a real directory holding a
    // link per binary. Resolving only the parent never leaves bin/, so the
    // whole path has to be resolved to reach the Cellar.
    const linked = path.join(path.sep, "opt", "homebrew", "bin", "scrcpy")
    const cellar = path.join(path.sep, "opt", "homebrew", "Cellar", "scrcpy", "4.1")
    const cellarClient = path.join(cellar, "bin", "scrcpy")
    const cellarServer = path.join(cellar, "share", "scrcpy", "scrcpy-server")
    mockCommands({ which: `${linked}\n`, where: `${linked}\n` })
    mockFilesystem([linked, cellarClient, cellarServer])
    mockSymlinks({ [linked]: cellarClient })
    expect(computeScrcpyServerPath()).toBe(cellarServer)
  })

  it("keeps the link's own prefix in play when the target sits outside bin", () => {
    // A distro can point /usr/bin/scrcpy at a private libexec copy while the
    // server stays in the packaged <prefix>/share. The resolved directory is
    // not a bin/, so only the link's own directory yields that prefix.
    const linkedClient = path.join(path.sep, "usr", "bin", "scrcpy")
    const realClient = path.join(path.sep, "usr", "lib", "scrcpy", "scrcpy")
    mockCommands({ which: `${linkedClient}\n`, where: `${linkedClient}\n` })
    mockFilesystem([linkedClient, realClient, otherPrefixServer])
    mockSymlinks({ [linkedClient]: realClient })
    expect(computeScrcpyServerPath()).toBe(otherPrefixServer)
  })

  it("asks the package manager when neither the env var nor PATH resolves", () => {
    // No hardcoded prefixes: dpkg reports where this distribution actually put
    // the server, which is the only way to be right on an unfamiliar host.
    mockCommands({
      "dpkg -L scrcpy-server": [
        path.join(path.sep, "usr", "share", "doc", "scrcpy-server"),
        path.join(path.sep, "usr", "share", "scrcpy"),
        otherPrefixServer,
      ].join("\n"),
    })
    mockFilesystem([otherPrefixServer])
    expect(computeScrcpyServerPath()).toBe(otherPrefixServer)
  })

  // Each manager answers in its own shape: pacman prefixes every line with the
  // package name, apk lists paths relative to the filesystem root, and brew
  // answers with a prefix rather than a listing. One case per manager, so a
  // failure names the manager that broke instead of stopping at the first one.
  it.each([
    ["pacman", { "pacman -Ql scrcpy": `scrcpy ${otherPrefixServer}\n` }, otherPrefixServer],
    ["apk", { "apk info -L scrcpy": `${otherPrefixServer.slice(1)}\n` }, otherPrefixServer],
    ["brew", { "brew --prefix scrcpy": `${otherPrefix}\n` }, otherPrefixServer],
  ])("reads the package listing format %s uses", (_manager, commands, expected) => {
    mockFilesystem([otherPrefixServer])
    mockCommands(commands)
    expect(computeScrcpyServerPath()).toBe(expected)
  })

  it("keeps spaces in a pacman path", () => {
    // "<pkg> <path>": splitting the line on whitespace truncates any path that
    // contains a space, so the server would be silently missed on a prefix like
    // /opt/my apps/scrcpy.
    const spacedServer = path.join(path.sep, "opt", "my apps", "scrcpy", "scrcpy-server")
    mockCommands({ "pacman -Ql scrcpy": `scrcpy ${spacedServer}\n` })
    mockFilesystem([spacedServer])
    expect(computeScrcpyServerPath()).toBe(spacedServer)
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

  it("resolves from the client on PATH when the env var is unset", () => {
    mockFilesystem([scrcpyBinary, siblingServer])
    mockCommands({
      which: `${scrcpyBinary}\n`,
      where: `${scrcpyBinary}\n`,
      [scrcpyBinary]: "scrcpy 4.0 <https://github.com/Genymobile/scrcpy>\n",
    })

    expect(computeScrcpyVersionInfo()).toEqual({ version: "4.0", source: "binary" })
    // The resolved client is probed by its full path, never a bare `scrcpy`
    // that PATH could resolve to a different install than the one discovered.
    expect(execFileSyncMock).toHaveBeenCalledWith(
      scrcpyBinary,
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

  it("prefers SCRCPY_SERVER_PATH's install over a different scrcpy on PATH", () => {
    // Issue #56, inverting the precedence this test used to pin. Setting
    // SCRCPY_SERVER_PATH is the user designating one install, so its own client
    // is the authority on its version. Announcing the PATH client's version
    // instead makes the server exit: "The server version (3.3.4) does not match
    // the client (1.25)". Ordering stays a decision, not an accident.
    process.env.SCRCPY_SERVER_PATH = prefixServer
    mockFilesystem([prefixServer, prefixClient, otherPrefixClient, otherPrefixServer])
    mockCommands({
      which: `${otherPrefixClient}\n`,
      where: `${otherPrefixClient}\n`,
      [otherPrefixClient]: "scrcpy 1.25 <https://github.com/Genymobile/scrcpy>\n",
      [prefixClient]: "scrcpy 3.3.4 <https://github.com/Genymobile/scrcpy>\n",
    })

    expect(computeScrcpyVersionInfo()).toEqual({
      version: "3.3.4",
      source: "server-sibling",
    })
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      otherPrefixClient,
      expect.anything(),
      expect.anything()
    )
  })

  it("reports the version of the install PATH resolved, not another one", () => {
    // The same crossing, reachable with no environment variable set: the
    // version must describe the server that install is about to push.
    mockFilesystem([prefixClient, prefixServer, otherPrefixClient, otherPrefixServer])
    mockCommands({
      which: `${otherPrefixClient}\n`,
      where: `${otherPrefixClient}\n`,
      [otherPrefixClient]: "scrcpy 1.25 <https://github.com/Genymobile/scrcpy>\n",
      [prefixClient]: "scrcpy 3.3.4 <https://github.com/Genymobile/scrcpy>\n",
    })

    expect(computeScrcpyVersionInfo()).toEqual({ version: "1.25", source: "binary" })
    expect(findScrcpyServer()).toBe(otherPrefixServer)
  })

  it("labels a package-manager-resolved install", () => {
    mockFilesystem([otherPrefixServer, otherPrefixClient])
    mockCommands({
      "dpkg -L scrcpy-server": `${otherPrefixServer}\n`,
      [otherPrefixClient]: "scrcpy 1.25 <https://github.com/Genymobile/scrcpy>\n",
    })

    expect(computeScrcpyVersionInfo()).toEqual({
      version: "1.25",
      source: "package-manager",
    })
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

  it("falls back to the default rather than borrowing an unrelated PATH client", () => {
    // The #56 regression direction: a lone server has no client of its own, and
    // some other scrcpy is on PATH answering --version. Reporting that version
    // is exactly what made the device server exit; the default is the only
    // honest answer, and SCRCPY_SERVER_VERSION is how the user corrects it.
    const loneServer = path.join(path.sep, "downloads", "scrcpy-server")
    process.env.SCRCPY_SERVER_PATH = loneServer
    mockFilesystem([loneServer, otherPrefixClient, otherPrefixServer])
    mockCommands({
      which: `${otherPrefixClient}\n`,
      where: `${otherPrefixClient}\n`,
      [otherPrefixClient]: "scrcpy 1.25 <https://github.com/Genymobile/scrcpy>",
    })
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    expect(computeScrcpyVersionInfo()).toEqual({
      version: SCRCPY_SERVER_VERSION,
      source: "default",
    })
    // The unrelated client must never be probed for this server's version.
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      otherPrefixClient,
      ["--version"],
      expect.anything()
    )
    consoleErrorSpy.mockRestore()
  })

  it("falls back to the default when the binary output does not match", () => {
    mockFilesystem([scrcpyBinary, siblingServer])
    mockCommands({
      which: `${scrcpyBinary}\n`,
      where: `${scrcpyBinary}\n`,
      [scrcpyBinary]: "not a scrcpy version line",
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
      mockFilesystem([scrcpyBinary, siblingServer])
      mockCommands({
        which: `${scrcpyBinary}\n`,
        where: `${scrcpyBinary}\n`,
        [scrcpyBinary]: "scrcpy 3.3.4 <url>\n",
      })
      __resetScrcpyDetectionCachesForTests()
      expect(computeScrcpyVersionInfo()).toEqual({ version: "3.3.4", source: "binary" })

      mockFilesystem([otherPrefixServer, otherPrefixClient])
      mockCommands({
        "dpkg -L scrcpy-server": `${otherPrefixServer}\n`,
        [otherPrefixClient]: "scrcpy 1.25 <url>\n",
      })
      __resetScrcpyDetectionCachesForTests()
      expect(computeScrcpyVersionInfo()).toEqual({
        version: "1.25",
        source: "package-manager",
      })

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
    mockFilesystem([scrcpyBinary, siblingServer])
    mockCommands({
      which: `${scrcpyBinary}\n`,
      where: `${scrcpyBinary}\n`,
      [scrcpyBinary]: "scrcpy 4.0 <https://github.com/Genymobile/scrcpy>\n",
    })

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
