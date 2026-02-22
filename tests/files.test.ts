import { describe, it, expect } from "vitest"
import { parseLsOutput } from "../src/tools/files.js"

// Typical Android toybox ls -la output
const SAMPLE_LS = `total 48
drwxrwxrwx  8 root sdcard_rw  4096 2024-03-10 09:00 .
drwxr-xr-x 23 root root       4096 2024-01-01 00:00 ..
drwxrwxrwx  2 root sdcard_rw  4096 2024-03-10 08:00 DCIM
drwxrwxrwx  3 root sdcard_rw  4096 2024-02-14 12:30 Android
-rw-rw----  1 root sdcard_rw  1024 2024-03-10 09:15 notes.txt
-rw-rw----  1 root sdcard_rw 98304 2024-03-09 18:45 video.mp4
lrwxrwxrwx  1 root root          7 2024-01-01 00:00 sdcard -> /sdcard`

describe("parseLsOutput", () => {
  it("parses all entries (excluding total line)", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    expect(entries.length).toBe(7) // . .. DCIM Android notes.txt video.mp4 sdcard
  })

  it("identifies directories by permissions", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    const dirs = entries.filter((e) => e.isDirectory)
    expect(dirs.length).toBe(4) // . .. DCIM Android
    expect(dirs.map((d) => d.name)).toContain("DCIM")
    expect(dirs.map((d) => d.name)).toContain("Android")
  })

  it("identifies regular files", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    const files = entries.filter((e) => !e.isDirectory)
    expect(files.length).toBe(3) // notes.txt video.mp4 sdcard (symlink)
  })

  it("parses file name", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    const notes = entries.find((e) => e.name === "notes.txt")
    expect(notes).toBeDefined()
  })

  it("parses permissions correctly", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    const notes = entries.find((e) => e.name === "notes.txt")
    expect(notes?.permissions).toBe("-rw-rw----")
  })

  it("parses owner and group", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    const notes = entries.find((e) => e.name === "notes.txt")
    expect(notes?.owner).toBe("root")
    expect(notes?.group).toBe("sdcard_rw")
  })

  it("parses size as a number", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    const notes = entries.find((e) => e.name === "notes.txt")
    expect(notes?.size).toBe(1024)
    const video = entries.find((e) => e.name === "video.mp4")
    expect(video?.size).toBe(98304)
  })

  it("parses date string", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    const notes = entries.find((e) => e.name === "notes.txt")
    expect(notes?.date).toBe("2024-03-10 09:15")
  })

  it("strips symlink target from name", () => {
    const entries = parseLsOutput(SAMPLE_LS)
    const link = entries.find((e) => e.name === "sdcard")
    expect(link).toBeDefined()
    expect(link?.name).toBe("sdcard")
    expect(link?.name).not.toContain("->")
  })

  it("returns empty array for empty output", () => {
    expect(parseLsOutput("")).toHaveLength(0)
  })

  it("returns empty array for only a total line", () => {
    expect(parseLsOutput("total 0")).toHaveLength(0)
  })

  it("skips unrecognised lines", () => {
    const output = "total 0\nnot a valid ls line\n-rw-r--r-- 1 root root 5 2024-01-01 00:00 file.txt"
    const entries = parseLsOutput(output)
    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe("file.txt")
  })

  it("handles optional SELinux suffix (.) on permissions", () => {
    const output = "total 0\n-rw-r--r--. 1 root root 10 2024-01-01 00:00 selinux.txt"
    const entries = parseLsOutput(output)
    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe("selinux.txt")
    expect(entries[0].permissions).toBe("-rw-r--r--.")
  })

  it("handles optional SELinux suffix (+) on permissions", () => {
    const output = "total 0\ndrwxrwx--x+ 4 root sdcard_rw 4096 2024-01-01 00:00 shared"
    const entries = parseLsOutput(output)
    expect(entries.length).toBe(1)
    expect(entries[0].isDirectory).toBe(true)
    expect(entries[0].name).toBe("shared")
  })
})
