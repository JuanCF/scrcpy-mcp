export interface FrameSize {
  width: number
  height: number
}

const EMPTY: Buffer = Buffer.alloc(0)
const START_CODE = Buffer.from([0x00, 0x00, 0x01])
const NAL_TYPE_MASK = 0x1f
const NAL_TYPE_SPS = 7
// Real SPS units are a few dozen bytes. An SPS still unterminated after this
// many is parsed from what has arrived instead of being buffered further.
const MAX_SPS_BYTES = 512
// Profiles whose SPS carries the chroma format / bit depth / scaling fields
// (H.264 spec 7.3.2.1.1).
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

function stripEmulationPrevention(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length)
  let length = 0
  let zeros = 0
  for (const byte of data) {
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0
      continue
    }
    zeros = byte === 0x00 ? zeros + 1 : 0
    out[length++] = byte
  }
  return out.subarray(0, length)
}

interface BitReader {
  bit: () => number
  bits: (count: number) => number
  ue: () => number
  se: () => number
}

function createBitReader(data: Buffer): BitReader {
  let position = 0
  const bit = (): number => {
    if (position >= data.length * 8) throw new RangeError("SPS truncated")
    const value = (data[position >> 3] >> (7 - (position & 7))) & 1
    position++
    return value
  }
  const bits = (count: number): number => {
    let value = 0
    for (let i = 0; i < count; i++) value = value * 2 + bit()
    return value
  }
  const ue = (): number => {
    let leadingZeros = 0
    while (bit() === 0) {
      if (++leadingZeros > 31) throw new RangeError("Invalid exp-golomb code")
    }
    return 2 ** leadingZeros - 1 + bits(leadingZeros)
  }
  const se = (): number => {
    const code = ue()
    return code % 2 === 0 ? -(code / 2) : (code + 1) / 2
  }
  return { bit, bits, ue, se }
}

function skipScalingList(reader: BitReader, size: number): void {
  let lastScale = 8
  let nextScale = 8
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) nextScale = (lastScale + reader.se() + 256) % 256
    if (nextScale !== 0) lastScale = nextScale
  }
}

/**
 * Read the picture size out of an H.264 sequence parameter set. `nal` starts at
 * the NAL header byte (after the start code); bytes past the end of the SPS
 * are ignored. Returns null when the unit is not a well-formed SPS.
 */
export function parseSpsSize(nal: Buffer): FrameSize | null {
  if (nal.length < 4) return null
  if ((nal[0] & 0x80) !== 0 || (nal[0] & NAL_TYPE_MASK) !== NAL_TYPE_SPS) return null

  try {
    const reader = createBitReader(stripEmulationPrevention(nal.subarray(1)))
    const profileIdc = reader.bits(8)
    reader.bits(16) // constraint flags, level_idc
    reader.ue() // seq_parameter_set_id

    let chromaArrayType = 1
    if (HIGH_PROFILES.has(profileIdc)) {
      const chromaFormatIdc = reader.ue()
      const separateColourPlane = chromaFormatIdc === 3 && reader.bit() === 1
      chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc
      reader.ue() // bit_depth_luma_minus8
      reader.ue() // bit_depth_chroma_minus8
      reader.bit() // qpprime_y_zero_transform_bypass_flag
      if (reader.bit() === 1) {
        const listCount = chromaFormatIdc === 3 ? 12 : 8
        for (let i = 0; i < listCount; i++) {
          if (reader.bit() === 1) skipScalingList(reader, i < 6 ? 16 : 64)
        }
      }
    }

    reader.ue() // log2_max_frame_num_minus4
    const picOrderCntType = reader.ue()
    if (picOrderCntType === 0) {
      reader.ue() // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      reader.bit() // delta_pic_order_always_zero_flag
      reader.se() // offset_for_non_ref_pic
      reader.se() // offset_for_top_to_bottom_field
      const cycleLength = reader.ue()
      if (cycleLength > 255) return null
      for (let i = 0; i < cycleLength; i++) reader.se()
    }
    reader.ue() // max_num_ref_frames
    reader.bit() // gaps_in_frame_num_value_allowed_flag

    const widthInMbs = reader.ue() + 1
    const heightInMapUnits = reader.ue() + 1
    const frameMbsOnly = reader.bit()
    if (frameMbsOnly === 0) reader.bit() // mb_adaptive_frame_field_flag
    reader.bit() // direct_8x8_inference_flag

    let cropLeft = 0
    let cropRight = 0
    let cropTop = 0
    let cropBottom = 0
    if (reader.bit() === 1) {
      cropLeft = reader.ue()
      cropRight = reader.ue()
      cropTop = reader.ue()
      cropBottom = reader.ue()
    }

    const fieldFactor = 2 - frameMbsOnly
    const cropUnitX = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1
    const cropUnitY = (chromaArrayType === 1 ? 2 : 1) * fieldFactor
    const width = widthInMbs * 16 - cropUnitX * (cropLeft + cropRight)
    const height = heightInMapUnits * 16 * fieldFactor - cropUnitY * (cropTop + cropBottom)
    if (width <= 0 || height <= 0 || width > 0xffff || height > 0xffff) return null

    return { width, height }
  } catch {
    return null
  }
}

function trailingZeros(data: Buffer): number {
  const length = data.length
  if (length >= 2 && data[length - 2] === 0x00 && data[length - 1] === 0x00) return 2
  if (length >= 1 && data[length - 1] === 0x00) return 1
  return 0
}

/**
 * Watch an Annex B H.264 byte stream for sequence parameter sets and report the
 * picture size of each one. Chunks may split the stream anywhere, including
 * inside a start code or inside the SPS itself.
 */
export function createSpsScanner(onSps: (size: FrameSize) => void): (chunk: Buffer) => void {
  let pending: Buffer = EMPTY

  return (chunk: Buffer): void => {
    const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    // A start code can straddle two chunks, so trailing zero bytes that may
    // be the beginning of one are carried over.
    let keepFrom = data.length - trailingZeros(data)
    let position = 0

    while (position < data.length) {
      const startCode = data.indexOf(START_CODE, position)
      if (startCode === -1) break

      const header = startCode + START_CODE.length
      if (header >= data.length) {
        keepFrom = startCode
        break
      }
      position = header
      if ((data[header] & NAL_TYPE_MASK) !== NAL_TYPE_SPS) continue

      const next = data.indexOf(START_CODE, header)
      if (next === -1 && data.length - header < MAX_SPS_BYTES) {
        keepFrom = startCode
        break
      }

      const end = next === -1 ? header + MAX_SPS_BYTES : next
      const size = parseSpsSize(data.subarray(header, end))
      if (size) onSps(size)
    }

    pending = keepFrom < data.length ? Buffer.from(data.subarray(keepFrom)) : EMPTY
  }
}
