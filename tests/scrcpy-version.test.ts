import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execSync } from "child_process"
import {
  buildServerArgs,
  videoMetaLayout,
  computeScrcpyVersionInfo,
  detectScrcpyVersionInfo,
  detectScrcpyVersion,
  __resetScrcpyVersionCacheForTests,
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
  return { ...actual, execSync: vi.fn() }
})

const execSyncMock = vi.mocked(execSync)

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

describe("computeScrcpyVersionInfo", () => {
  const originalEnv = process.env.SCRCPY_SERVER_VERSION

  beforeEach(() => {
    execSyncMock.mockReset()
    delete process.env.SCRCPY_SERVER_VERSION
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SCRCPY_SERVER_VERSION
    } else {
      process.env.SCRCPY_SERVER_VERSION = originalEnv
    }
  })

  it("resolves from the SCRCPY_SERVER_VERSION env var without spawning the binary", () => {
    process.env.SCRCPY_SERVER_VERSION = "4.2"
    expect(computeScrcpyVersionInfo()).toEqual({ version: "4.2", source: "env" })
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it("resolves from the scrcpy binary when the env var is unset", () => {
    execSyncMock.mockReturnValue(
      "scrcpy 4.0 <https://github.com/Genymobile/scrcpy>\n"
    )
    expect(computeScrcpyVersionInfo()).toEqual({ version: "4.0", source: "binary" })
  })

  it("falls back to the default when the binary output does not match", () => {
    execSyncMock.mockReturnValue("not a scrcpy version line")
    expect(computeScrcpyVersionInfo()).toEqual({
      version: SCRCPY_SERVER_VERSION,
      source: "default",
    })
  })

  it("falls back to the default when the binary is unavailable", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("command not found: scrcpy")
    })
    expect(computeScrcpyVersionInfo()).toEqual({
      version: SCRCPY_SERVER_VERSION,
      source: "default",
    })
  })

  it("never reports a source that disagrees with its version", () => {
    // Regression guard: version and source must come from one resolution, so
    // a binary-derived version can never be labelled 'default' and vice versa.
    execSyncMock.mockReturnValue("scrcpy 3.3.4 <url>\n")
    const info = computeScrcpyVersionInfo()
    expect(info.source).toBe("binary")
    expect(info.version).toBe("3.3.4")
  })
})

describe("detectScrcpyVersionInfo", () => {
  it("memoizes the first resolution and keeps version/source consistent", () => {
    __resetScrcpyVersionCacheForTests()
    const originalEnv = process.env.SCRCPY_SERVER_VERSION
    delete process.env.SCRCPY_SERVER_VERSION
    execSyncMock.mockReset()
    execSyncMock.mockReturnValue("scrcpy 4.0 <https://github.com/Genymobile/scrcpy>\n")

    try {
      const first = detectScrcpyVersionInfo()
      expect(first).toEqual({ version: "4.0", source: "binary" })
      expect(detectScrcpyVersion()).toBe(first.version)

      // Cache is now populated; a later resolution failure must not change it.
      execSyncMock.mockImplementation(() => {
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
      __resetScrcpyVersionCacheForTests()
    }
  })
})
