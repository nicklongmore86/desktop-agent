// Image size checks and scaling. Dimensions come from the file header before
// anything decodes it, so a small file that unpacks to a huge bitmap is refused
// first. Decoding and resizing go through an injected ImageScaler (Electron's
// nativeImage at wiring time, see native-image.ts) so tests run without Electron.
import { ATTACHMENT_LIMITS } from '../../shared/attachments'

export interface ImageSize {
  width: number
  height: number
}

/** Decodes and re-encodes images. */
export interface ImageScaler {
  /**
   * Scales `bytes` so the longest side is at most `maxSide`. Resolves to null when this
   * format cannot be decoded here.
   */
  scale(
    bytes: Buffer,
    mime: string,
    maxSide: number,
  ): Promise<{ bytes: Buffer; mime: string } | null>
}

/** More pixels than this is refused before decoding (8192 x 8192). */
export const MAX_IMAGE_PIXELS = 8192 * 8192

const u16be = (b: Buffer, at: number) => b.readUInt16BE(at)
const u24le = (b: Buffer, at: number) => b.readUIntLE(at, 3)

function jpegSize(b: Buffer): ImageSize | null {
  let at = 2
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null
    const marker = b.readUInt8(at + 1)
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    const length = u16be(b, at + 2)
    // Start of frame (baseline, progressive, ...); C4/C8/CC are other tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: u16be(b, at + 5), width: u16be(b, at + 7) }
    if (length < 2) return null
    at += 2 + length
  }
  return null
}

function webpSize(b: Buffer): ImageSize | null {
  if (b.length < 30) return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ')
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  return null
}

/** Width and height from the header of a PNG, JPEG, GIF or WebP file, or null if unreadable. */
export function imageSize(bytes: Buffer, mime: string): ImageSize | null {
  try {
    switch (mime) {
      case 'image/png':
        return bytes.length < 24
          ? null
          : { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      case 'image/gif':
        return bytes.length < 10
          ? null
          : { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
      case 'image/jpeg':
        return jpegSize(bytes)
      case 'image/webp':
        return webpSize(bytes)
      default:
        return null
    }
  } catch {
    return null
  }
}

export type PreparedImage =
  | { ok: true; bytes: Buffer; mime: string }
  | { ok: false; code: 'too-large' | 'invalid'; reason: string }

/**
 * Checks an image's header and scales it down so its longest side is at most
 * ATTACHMENT_LIMITS.imageMaxSide. Images already small enough are kept as they are.
 */
export async function prepareImage(
  bytes: Buffer,
  mime: string,
  scaler: ImageScaler,
): Promise<PreparedImage> {
  const size = imageSize(bytes, mime)
  if (!size || size.width <= 0 || size.height <= 0)
    return { ok: false, code: 'invalid', reason: 'This image could not be read.' }
  if (size.width * size.height > MAX_IMAGE_PIXELS)
    return {
      ok: false,
      code: 'too-large',
      reason: `This image is ${String(size.width)} x ${String(size.height)} pixels, too big to attach.`,
    }
  const maxSide = ATTACHMENT_LIMITS.imageMaxSide
  if (Math.max(size.width, size.height) <= maxSide) return { ok: true, bytes, mime }
  const scaled = await scaler.scale(bytes, mime, maxSide).catch(() => null)
  if (!scaled)
    return {
      ok: false,
      code: 'too-large',
      reason: `This image is bigger than ${String(maxSide)} pixels and cannot be scaled down here. Save it as PNG or JPEG and try again.`,
    }
  return { ok: true, ...scaled }
}
