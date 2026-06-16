// Generates icon.png — a simple, legible mark for scrcpy-mcp:
// a rounded dark-slate square with a white phone outline framing an Android-green
// play/stream triangle. No external deps: raw RGBA encoded to PNG via zlib.
import { deflateSync } from "node:zlib"
import { writeFileSync } from "node:fs"

const S = 512
const buf = Buffer.alloc(S * S * 4) // RGBA

function px(x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  // simple source-over blend
  const sa = a / 255
  const da = buf[i + 3] / 255
  const oa = sa + da * (1 - sa)
  if (oa === 0) return
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa)
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa)
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa)
  buf[i + 3] = Math.round(oa * 255)
}

const inRounded = (x, y, x0, y0, x1, y1, rad) => {
  if (x < x0 || y < y0 || x >= x1 || y >= y1) return false
  const cx = Math.min(Math.max(x, x0 + rad), x1 - rad)
  const cy = Math.min(Math.max(y, y0 + rad), y1 - rad)
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad
}

const fillRounded = (x0, y0, x1, y1, rad, color) => {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (inRounded(x, y, x0, y0, x1, y1, rad)) px(x, y, color)
}

const SLATE = [17, 24, 39]
const WHITE = [255, 255, 255]
const GREEN = [61, 220, 132] // Android green

// Background rounded square
fillRounded(0, 0, S, S, 112, SLATE)

// Phone: white rounded outline (outer white, inner slate) centered
const pw = 232, ph = 392
const px0 = (S - pw) / 2, py0 = (S - ph) / 2
fillRounded(px0, py0, px0 + pw, py0 + ph, 44, WHITE)
const b = 24
fillRounded(px0 + b, py0 + b, px0 + pw - b, py0 + ph - b, 26, SLATE)

// Play / stream triangle in the screen, Android green
const cx = S / 2 - 8, cy = S / 2
const tw = 96, th = 120
for (let y = -th / 2; y <= th / 2; y++) {
  const frac = 1 - Math.abs(y) / (th / 2)
  const xEnd = cx - tw / 2 + tw * frac
  for (let x = cx - tw / 2; x <= xEnd; x++) px(Math.round(x), Math.round(cy + y), GREEN)
}

// ---- PNG encode ----
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b) => {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8; ihdr[9] = 6 // 8-bit, RGBA
const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0 // filter none
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
])
writeFileSync(new URL("../icon.png", import.meta.url), png)
console.log("wrote icon.png", png.length, "bytes")
