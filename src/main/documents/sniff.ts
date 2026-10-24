import { listZipEntries } from './zip'
import type { DocumentKind } from './types'

export interface Sniffed {
  kind: DocumentKind
  mime: string
}

const MIME: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ooxml: 'application/octet-stream',
  odf: 'application/vnd.oasis.opendocument',
  zip: 'application/zip',
  ole: 'application/x-ole-storage',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  rtf: 'application/rtf',
  text: 'text/plain',
  unknown: 'application/octet-stream',
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])
const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124])

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((byte, i) => bytes[at + i] === byte)
const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to))

/**
 * Identifies a document by its leading bytes. The file name and any claimed MIME type
 * play no part: a renamed file is read as what it is.
 */
export function sniff(bytes: Uint8Array): Sniffed {
  const kind = sniffKind(bytes)
  return { kind, mime: kind === 'odf' ? odfMime(bytes) : MIME[kind] }
}

function sniffKind(bytes: Uint8Array): DocumentKind {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return zipKind(bytes)
  }
  // Readers accept a PDF header anywhere in the first KiB.
  if (pdfHeaderAt(bytes) >= 0) return 'pdf'
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp'
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff'
  }
  if (ascii(bytes, 0, 2) === 'BM' && bytes.length >= 18) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (BMP_HEADER_SIZES.has(view.getUint32(14, true))) return 'bmp'
  }
  const heif = heifKind(bytes)
  if (heif) return heif
  if (ascii(bytes, 0, 5) === '{\\rtf') return 'rtf'
  if (looksLikeText(bytes)) return 'text'
  return 'unknown'
}

export function pdfHeaderAt(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length - 5, 1024)
  for (let at = 0; at <= limit; at++) {
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], at)) return at
  }
  return -1
}

/** ISO BMFF `ftyp` box: the major brand and the compatible brands after it. */
function heifKind(bytes: Uint8Array): DocumentKind | null {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxSize = Math.min(view.getUint32(0), bytes.length, 4096)
  const brands = [ascii(bytes, 8, 12)]
  for (let at = 16; at + 4 <= boxSize; at += 4) brands.push(ascii(bytes, at, at + 4))
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'avif'
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) return 'heic'
  return null
}

function zipKind(bytes: Uint8Array): DocumentKind {
  // ODF stores an uncompressed `mimetype` entry first, readable from the local header.
  if (ascii(bytes, 30, 38) === 'mimetype' && odfMime(bytes) !== MIME.odf) return 'odf'
  let names: Set<string>
  try {
    names = new Set(listZipEntries(bytes).map((entry) => entry.name))
  } catch {
    return 'zip'
  }
  if (!names.has('[Content_Types].xml')) return 'zip'
  if (names.has('word/document.xml')) return 'docx'
  if (names.has('xl/workbook.xml')) return 'xlsx'
  if (names.has('ppt/presentation.xml')) return 'pptx'
  return 'ooxml'
}

function odfMime(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 30) return MIME.odf
  const method = view.getUint16(8, true)
  const size = view.getUint32(18, true)
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const start = 30 + nameLength + extraLength
  if (method !== 0 || size > 100 || start + size > bytes.length) return MIME.odf
  const mime = ascii(bytes, start, start + size)
  return /^application\/vnd\.oasis\.opendocument\.[a-z.-]+$/.test(mime) ? mime : MIME.odf
}

/** No NUL bytes and few control bytes in the first 8 KiB, and valid UTF-8 (or a UTF-16 BOM). */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return true
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return false
  // Control characters other than tab, newlines, form feed and escape mean binary.
  let control = 0
  for (const byte of head) {
    if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13 && byte !== 27) {
      control++
    }
  }
  if (control > head.length / 100) return false
  // A multi-byte character may be cut at the 8 KiB boundary: allow up to 3 trailing bytes.
  for (let trim = 0; trim <= 3 && trim < head.length; trim++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - trim))
      return true
    } catch {
      if (head.length < 8192) return false
    }
  }
  return false
}

export const KIND_LABEL: Record<DocumentKind, string> = {
  pdf: 'PDF',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pptx: 'PowerPoint presentation',
  ooxml: 'Office Open XML document',
  odf: 'OpenDocument file',
  zip: 'ZIP archive',
  ole: 'legacy Office (OLE) file',
  jpeg: 'JPEG image',
  png: 'PNG image',
  gif: 'GIF image',
  webp: 'WebP image',
  bmp: 'BMP image',
  tiff: 'TIFF image',
  avif: 'AVIF image',
  heic: 'HEIC/HEIF image',
  rtf: 'RTF document',
  text: 'text file',
  unknown: 'unrecognised file',
}
