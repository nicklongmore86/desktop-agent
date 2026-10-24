import { readHeif } from './heif'
import { DocumentError, type DocumentKind } from './types'

export interface DocumentLimits {
  /** Largest input accepted at all. */
  maxDocumentBytes: number
  /** Largest image (width x height) decoded or rendered, checked from headers before decoding. */
  maxDecodedPixels: number
  /** Pages read per call; the rest is reached through `position.next`. */
  maxPagesPerCall: number
  /** Images returned per call, whatever the caller's budget asks for. */
  maxImagesPerCall: number
  /** Default text budget per call. */
  defaultMaxChars: number
  /** Largest text budget a caller may ask for. */
  maxCharsPerCall: number
  /** Largest encoded image returned (the Anthropic API's per-image limit). */
  maxImageBytes: number
  /** Default and largest long edge of a returned image. */
  defaultLongEdge: number
  maxLongEdge: number
  /** How far a region may be zoomed past the page's natural size (72 dpi = 1). */
  maxRegionScale: number
  zip: ZipLimits
  office: OfficeLimits
}

/** Word, Excel, PowerPoint and OpenDocument files: their XML parts and what one call returns. */
export interface OfficeLimits {
  /** Largest XML part (uncompressed) parsed at all. */
  maxPartBytes: number
  /** Uncompressed bytes read from one package, every part together. */
  maxTotalBytes: number
  /** Deepest element nesting in an XML part. */
  maxXmlDepth: number
  /** Elements in one XML part. */
  maxXmlElements: number
  /** Spreadsheet cells returned per call. */
  maxCellsPerCall: number
  /** Rows of each sheet shown when no sheet or range is asked for. */
  previewRows: number
  /** Columns of each sheet shown when no range is asked for. */
  previewColumns: number
  /** Sheets listed (and so shown) per workbook. */
  maxSheets: number
}

export interface ZipLimits {
  maxEntries: number
  /** Uncompressed bytes allowed across every entry read from one archive. */
  maxTotalBytes: number
  maxEntryBytes: number
  /** Largest uncompressed / compressed ratio declared by an entry over 1 MiB. */
  maxRatio: number
}

const MiB = 1024 * 1024

export const DEFAULT_LIMITS: DocumentLimits = {
  maxDocumentBytes: 100 * MiB,
  maxDecodedPixels: 100_000_000,
  maxPagesPerCall: 50,
  maxImagesPerCall: 20,
  defaultMaxChars: 50_000,
  maxCharsPerCall: 500_000,
  maxImageBytes: 5 * MiB,
  defaultLongEdge: 1568,
  maxLongEdge: 4096,
  maxRegionScale: 8,
  zip: { maxEntries: 10_000, maxTotalBytes: 512 * MiB, maxEntryBytes: 256 * MiB, maxRatio: 200 },
  office: {
    maxPartBytes: 64 * MiB,
    maxTotalBytes: 256 * MiB,
    maxXmlDepth: 256,
    maxXmlElements: 4_000_000,
    maxCellsPerCall: 10_000,
    previewRows: 20,
    previewColumns: 30,
    maxSheets: 200,
  },
}

export function checkDocumentSize(size: number, limits: DocumentLimits = DEFAULT_LIMITS): void {
  if (size > limits.maxDocumentBytes) {
    throw new DocumentError(
      'too-large',
      `The file is ${formatMiB(size)}; documents up to ${formatMiB(limits.maxDocumentBytes)} can be read.`,
    )
  }
}

export function checkPixels(
  width: number,
  height: number,
  limits: DocumentLimits = DEFAULT_LIMITS,
): void {
  if (!(width > 0 && height > 0)) {
    throw new DocumentError('malformed', 'The image has no valid dimensions.')
  }
  if (width * height > limits.maxDecodedPixels) {
    throw new DocumentError(
      'too-many-pixels',
      `The image is ${String(width)} x ${String(height)} pixels; images up to ` +
        `${String(limits.maxDecodedPixels / 1_000_000)} megapixels can be read.`,
    )
  }
}

const formatMiB = (bytes: number): string => `${(bytes / MiB).toFixed(1)} MB`

/** The budgets a request actually gets: what it asked for, inside the hard limits. */
export function effectiveBudget(
  budget: { maxChars?: number; maxImages?: number; longEdge?: number } | undefined,
  limits: DocumentLimits = DEFAULT_LIMITS,
): { maxChars: number; maxImages: number; longEdge: number } {
  const whole = (value: number | undefined, fallback: number, max: number, min = 1): number =>
    value === undefined || !Number.isFinite(value)
      ? fallback
      : Math.max(min, Math.min(max, Math.floor(value)))
  return {
    maxChars: whole(budget?.maxChars, limits.defaultMaxChars, limits.maxCharsPerCall),
    maxImages: whole(budget?.maxImages, limits.maxImagesPerCall, limits.maxImagesPerCall, 0),
    longEdge: whole(budget?.longEdge, limits.defaultLongEdge, limits.maxLongEdge, 16),
  }
}

/**
 * An image's width and height read from its header, without decoding it, or null when
 * the header is missing or truncated. Dimensions are as stored, before EXIF orientation.
 */
export function imageDimensions(
  bytes: Uint8Array,
  kind: DocumentKind,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const has = (end: number): boolean => end <= bytes.length
  switch (kind) {
    case 'png':
      // The full signature, then an IHDR chunk of exactly 13 bytes: width, height, and five
      // one-byte fields.
      if (!has(PNG_HEADER.length + 13)) return null
      if (!PNG_HEADER.every((byte, i) => bytes[i] === byte)) return null
      return { width: view.getUint32(16), height: view.getUint32(20) }
    case 'gif':
      if (!has(10)) return null
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
    case 'bmp': {
      if (!has(26)) return null
      if (view.getUint32(14, true) === 12) {
        return { width: view.getUint16(18, true), height: view.getUint16(20, true) }
      }
      // Height is negative for top-down bitmaps.
      return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) }
    }
    case 'webp':
      return webpDimensions(bytes, view)
    case 'jpeg':
      return jpegDimensions(bytes, view)
    case 'tiff':
      return tiffDimensions(bytes, view)
    case 'heic':
    case 'avif':
      // The primary image's stored size, before its crop: what a decoder allocates.
      return readHeif(bytes)?.coded ?? null
    default:
      return null
  }
}

/** The PNG signature, then the first chunk's length (13) and type ('IHDR'). */
const PNG_HEADER = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
] as const

function webpDimensions(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | null {
  if (bytes.length < 30) return null
  const chunk = String.fromCharCode(...bytes.subarray(12, 16))
  if (chunk === 'VP8X') {
    const u24 = (at: number): number =>
      (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)
    return { width: u24(24) + 1, height: u24(27) + 1 }
  }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  return null
}

function jpegDimensions(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1] ?? 0
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // The frame header holds at least precision, height, width and a component count.
      const length = view.getUint16(at + 2)
      if (length < 8 || at + 2 + length > bytes.length) return null
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
    }
    if (marker === 0xda || marker === 0xd9) return null
    at += 2 + view.getUint16(at + 2)
  }
  return null
}

function tiffDimensions(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | null {
  if (bytes.length < 8) return null
  const little = bytes[0] === 0x49
  const ifd = view.getUint32(4, little)
  if (ifd + 2 > bytes.length) return null
  const count = view.getUint16(ifd, little)
  let width = 0
  let height = 0
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > bytes.length) return null
    const tag = view.getUint16(entry, little)
    if (tag !== 256 && tag !== 257) continue
    const type = view.getUint16(entry + 2, little)
    const value = type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little)
    if (tag === 256) width = value
    else height = value
  }
  return width && height ? { width, height } : null
}
