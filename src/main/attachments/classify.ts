// What kind of attachment some bytes are, and whether they are accepted at all.
// The one place that decides it: the validator and the store never look at
// content. Detection is by content (magic bytes and container structure), never
// by name or claimed type. A new kind is added here and in KIND_LIMITS.
//
// - image: formats a model takes as-is (MODEL_IMAGE_MIMES).
// - pdf.
// - document: originals that need extraction before a model can use them (Office,
//   OpenDocument, RTF, Outlook .msg, .eml, HEIC/TIFF/BMP/AVIF images). Stored as-is.
// - text: anything else that passes read_file's binary check.
// Executables, archives and other binaries are refused.
import { ATTACHMENT_LIMITS, MODEL_IMAGE_MIMES, type AttachmentKind } from '../../shared/attachments'
import { looksBinary } from '../tools/text'

/** How many leading bytes the first classifyAttachment call looks at (read_file's sniff window). */
export const CLASSIFY_BYTES = 8000
/** The most bytes classifyAttachment ever asks for at either end of a file. */
export const CLASSIFY_MAX_BYTES = 1024 * 1024

export type Classification =
  | { ok: true; kind: AttachmentKind; mime: string }
  /** Not an accepted kind: executables, archives and other binaries are refused. */
  | { ok: false; code: 'binary' }
  /**
   * The sample is not enough to decide: call again with at least the file's first `head`
   * and last `tail` bytes (each at most CLASSIFY_MAX_BYTES). If the caller cannot give
   * more than it did, the file is refused.
   */
  | { ok: false; code: 'need-more'; head?: number; tail?: number }

/** What classifyAttachment looks at: the start and the end of a file, and its size. */
export interface FileSample {
  /** The file's first bytes (all of them when the file is short). */
  head: Uint8Array
  /** The file's last bytes; may be empty, and may overlap `head`. */
  tail: Uint8Array
  /** The whole file's size in bytes. */
  size: number
}

const BINARY = { ok: false, code: 'binary' } as const satisfies Classification
const accept = (kind: AttachmentKind, mime: string): Classification => ({ ok: true, kind, mime })

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((byte, i) => bytes[at + i] === byte)

const ascii = (text: string): number[] => Array.from(Buffer.from(text, 'latin1'))
const hasAscii = (bytes: Uint8Array, text: string, at = 0): boolean =>
  startsWith(bytes, ascii(text), at)

type ModelImageMime = (typeof MODEL_IMAGE_MIMES)[number]
const MODEL_IMAGES: readonly { mime: ModelImageMime; test: (b: Uint8Array) => boolean }[] = [
  {
    mime: 'image/png',
    test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: 'image/jpeg', test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: 'image/gif', test: (b) => hasAscii(b, 'GIF87a') || hasAscii(b, 'GIF89a') },
  { mime: 'image/webp', test: (b) => hasAscii(b, 'RIFF') && hasAscii(b, 'WEBP', 8) },
]

/** Images a model cannot take directly: kept as documents for conversion. */
function otherImage(b: Uint8Array): string | null {
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff'
  if (hasAscii(b, 'BM') && b.length >= 18) {
    // The DIB header size: one of the known BMP header versions.
    const dib = Buffer.from(b.buffer, b.byteOffset, b.byteLength).readUInt32LE(14)
    if ([12, 40, 52, 56, 108, 124].includes(dib)) return 'image/bmp'
  }
  if (hasAscii(b, 'ftyp', 4)) {
    const brand = Buffer.from(b.subarray(8, 12)).toString('latin1')
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'image/heic'
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif'
    if (['avif', 'avis'].includes(brand)) return 'image/avif'
  }
  return null
}

// OLE2 compound files (legacy Office, Outlook .msg; also .msi installers, which are refused).
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
/** Root-entry class ids of the documents accepted. */
const OLE_CLASSES = new Map<string, string>([
  ['00020906-0000-0000-c000-000000000046', 'application/msword'],
  ['00020900-0000-0000-c000-000000000046', 'application/msword'],
  ['00020820-0000-0000-c000-000000000046', 'application/vnd.ms-excel'],
  ['00020810-0000-0000-c000-000000000046', 'application/vnd.ms-excel'],
  ['64818d10-4f9b-11cf-86ea-00aa00b929e8', 'application/vnd.ms-powerpoint'],
  ['00020d0b-0000-0000-c000-000000000046', 'application/vnd.ms-outlook'],
])
/** Stream names that identify the document when the class id is not set. */
const OLE_STREAMS: readonly [string, string][] = [
  ['WordDocument', 'application/msword'],
  ['Workbook', 'application/vnd.ms-excel'],
  ['Book', 'application/vnd.ms-excel'],
  ['PowerPoint Document', 'application/vnd.ms-powerpoint'],
  ['__substg1.0_', 'application/vnd.ms-outlook'],
]

function classId(b: Buffer, at: number): string {
  const hex = (start: number, end: number) => b.subarray(start, end).toString('hex')
  const le = (start: number, length: number) =>
    Buffer.from(b.subarray(start, start + length))
      .reverse()
      .toString('hex')
  return `${le(at, 4)}-${le(at + 4, 2)}-${le(at + 6, 2)}-${hex(at + 8, at + 10)}-${hex(at + 10, at + 16)}`
}

function oleDocument(b: Buffer): Classification {
  if (b.length < 0x34) return { ok: false, code: 'need-more', head: 512 }
  const shift = b.readUInt16LE(0x1e)
  if (shift !== 9 && shift !== 12) return BINARY
  const sector = 1 << shift
  // The first directory sector; its first entry is the root, which carries the class id.
  const directory = (b.readUInt32LE(0x30) + 1) * sector
  if (directory + sector > CLASSIFY_MAX_BYTES) return BINARY
  if (directory + sector > b.length)
    return { ok: false, code: 'need-more', head: directory + sector }
  const known = OLE_CLASSES.get(classId(b, directory + 0x50))
  if (known) return accept('document', known)
  const names = b.subarray(directory, directory + sector).toString('utf16le')
  for (const [stream, mime] of OLE_STREAMS)
    if (names.includes(stream)) return accept('document', mime)
  return BINARY
}

/** Office Open XML packages, by the main part a real one always has. */
const OOXML: readonly [string, string][] = [
  ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [
    'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
]

/** More central directory entries than any Office file has: refused. */
export const MAX_ZIP_ENTRIES = 10_000

const EOCD = 0x06054b50
const EOCD_SIZE = 22
const ZIP64_LOCATOR = 0x07064b50
const CENTRAL_ENTRY = 0x02014b50
const LOCAL_ENTRY = 0x04034b50
/**
 * General-purpose flags of an encrypted entry: traditional encryption (bit 0), strong
 * encryption (bit 6) and an encrypted central directory with masked local headers (bit 13).
 */
const ENCRYPTED_FLAGS = 0x0001 | 0x0040 | 0x2000
/** Compression method of WinZip AES encryption. */
const AES_METHOD = 99

/** The end record plus the longest comment it may have: where EOCD must be. */
const EOCD_SEARCH = EOCD_SIZE + 0xffff

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

/**
 * The bytes of the file from `start` (absolute) to `end`, from whichever of the head or
 * tail holds all of them, or null when neither does.
 */
function slice(sample: FileSample, start: number, end: number): Buffer | null {
  const { head, tail, size } = sample
  if (start < 0 || end > size || end < start) return null
  if (end <= head.length) return Buffer.from(head.buffer, head.byteOffset + start, end - start)
  const tailStart = size - tail.length
  if (start >= tailStart)
    return Buffer.from(tail.buffer, tail.byteOffset + start - tailStart, end - start)
  return null
}

/**
 * Reads a zip's central directory from the end of the file: the end record (the
 * comment length must end it exactly at the end of the file), then each entry with
 * bounds checks. Multi-disk (in the end record or any entry), ZIP64 and encrypted
 * archives, duplicate names, more than
 * MAX_ZIP_ENTRIES entries, and anything inconsistent are refused.
 */
function zipDirectory(sample: FileSample): ZipEntry[] | Classification {
  const { size } = sample
  const search = Math.min(size, EOCD_SEARCH)
  const end = slice(sample, size - search, size)
  if (!end) return { ok: false, code: 'need-more', tail: search }
  let eocd = -1
  for (let at = end.length - EOCD_SIZE; at >= 0; at--) {
    if (
      end.readUInt32LE(at) === EOCD &&
      at + EOCD_SIZE + end.readUInt16LE(at + 20) === end.length
    ) {
      eocd = at
      break
    }
  }
  if (eocd < 0) return BINARY
  const eocdAt = size - search + eocd
  const disk = end.readUInt16LE(eocd + 4)
  const cdDisk = end.readUInt16LE(eocd + 6)
  const onDisk = end.readUInt16LE(eocd + 8)
  const count = end.readUInt16LE(eocd + 10)
  const cdSize = end.readUInt32LE(eocd + 12)
  const cdOffset = end.readUInt32LE(eocd + 16)
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) return BINARY
  // ZIP64 (sentinel values or a ZIP64 locator): never needed by documents this small.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return BINARY
  if (eocd >= 20 && end.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) return BINARY
  if (count === 0 || count > MAX_ZIP_ENTRIES) return BINARY
  // The directory sits right before the end record.
  if (cdOffset + cdSize !== eocdAt) return BINARY
  if (size - cdOffset > CLASSIFY_MAX_BYTES) return BINARY
  const cd = slice(sample, cdOffset, eocdAt)
  if (!cd) return { ok: false, code: 'need-more', tail: size - cdOffset }

  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > cd.length || cd.readUInt32LE(at) !== CENTRAL_ENTRY) return BINARY
    const nameLength = cd.readUInt16LE(at + 28)
    const next = at + 46 + nameLength + cd.readUInt16LE(at + 30) + cd.readUInt16LE(at + 32)
    if (next > cd.length) return BINARY
    // Every entry on disk 0 (the end record's disk fields alone can be zeroed), and none
    // encrypted: an encrypted package cannot be read, so it is not a document here.
    if (cd.readUInt16LE(at + 34) !== 0) return BINARY
    if ((cd.readUInt16LE(at + 8) & ENCRYPTED_FLAGS) !== 0) return BINARY
    const entry: ZipEntry = {
      name: cd.toString('latin1', at + 46, at + 46 + nameLength),
      method: cd.readUInt16LE(at + 10),
      compressedSize: cd.readUInt32LE(at + 20),
      localOffset: cd.readUInt32LE(at + 42),
    }
    if (entry.method === AES_METHOD) return BINARY
    if (names.has(entry.name) || entry.localOffset + 30 > cdOffset) return BINARY
    names.add(entry.name)
    entries.push(entry)
    at = next
  }
  if (at !== cd.length) return BINARY
  return entries
}

/** True when the entry's local header, where readable, is a local header for that name. */
function localHeaderMatches(sample: FileSample, entry: ZipEntry): boolean {
  const name = Buffer.from(entry.name, 'latin1')
  const header = slice(sample, entry.localOffset, entry.localOffset + 30 + name.length)
  if (!header) return true // Not in the bytes read; the directory checks still hold.
  return (
    header.readUInt32LE(0) === LOCAL_ENTRY &&
    (header.readUInt16LE(6) & ENCRYPTED_FLAGS) === 0 &&
    header.readUInt16LE(8) !== AES_METHOD &&
    header.readUInt16LE(26) === name.length &&
    header.subarray(30).equals(name)
  )
}

/**
 * Office Open XML and OpenDocument packages, by their central directory: OOXML needs a
 * real `[Content_Types].xml` entry and its main part; OpenDocument a stored `mimetype`
 * first entry (at offset 0) naming an OpenDocument type. Any other zip (jar, apk, epub,
 * vsix...) is refused, whatever its compressed data contains.
 */
function zipDocument(sample: FileSample): Classification {
  const entries = zipDirectory(sample)
  if (!Array.isArray(entries)) return entries
  const byName = new Map(entries.map((e) => [e.name, e]))

  const mimetype = byName.get('mimetype')
  if (mimetype) {
    if (mimetype.localOffset !== 0 || mimetype.method !== 0 || mimetype.compressedSize > 100)
      return BINARY
    const local = slice(sample, 0, 30)
    if (!local || local.readUInt16LE(26) !== 8) return BINARY
    const start = 30 + 8 + local.readUInt16LE(28)
    const value = slice(sample, start, start + mimetype.compressedSize)
    if (!value || !localHeaderMatches(sample, mimetype)) return BINARY
    const type = value.toString('latin1')
    return /^application\/vnd\.oasis\.opendocument\.[a-z.-]+$/.test(type)
      ? accept('document', type)
      : BINARY
  }

  const contentTypes = byName.get('[Content_Types].xml')
  const main = OOXML.find(([part]) => byName.has(part))
  if (!contentTypes || !main) return BINARY
  const mainEntry = byName.get(main[0])
  if (
    !mainEntry ||
    !localHeaderMatches(sample, contentTypes) ||
    !localHeaderMatches(sample, mainEntry)
  )
    return BINARY
  return accept('document', main[1])
}

const MAIL_HEADER = /^(from|received|return-path|message-id|mime-version|delivered-to):/i
const MAIL_TOPIC = /^(subject|date):/i

/** An RFC 822 message (.eml): it starts with a block of header fields naming a mail. */
function isEmail(text: string): boolean {
  const end = text.search(/\r?\n\r?\n/)
  if (end <= 0) return false
  const lines = text.slice(0, end).split(/\r?\n/)
  if (!lines.every((line) => /^[!-9;-~]+:/.test(line) || /^[ \t]/.test(line))) return false
  return lines.some((l) => MAIL_HEADER.test(l)) && lines.some((l) => MAIL_TOPIC.test(l))
}

/**
 * Classifies a file by its content: start with its first CLASSIFY_BYTES (or the whole
 * file) and no tail, and call again with more when asked (`need-more`: zip packages are
 * recognised by their central directory at the end of the file). Text counts as text
 * unless read_file's binary check (`looksBinary`: a NUL byte or many control characters)
 * says otherwise; UTF-16 text with a byte-order mark is text, as it is for read_file.
 */
export function classifyAttachment(sample: FileSample): Classification {
  const { head } = sample
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength)
  for (const image of MODEL_IMAGES) if (image.test(b)) return accept('image', image.mime)
  if (hasAscii(b, '%PDF-')) return accept('pdf', 'application/pdf')
  const image = otherImage(b)
  if (image) return accept('document', image)
  if (startsWith(b, OLE_SIGNATURE)) return oleDocument(b)
  if (hasAscii(b, 'PK\x03\x04')) return zipDocument(sample)
  if (hasAscii(b, '{\\rtf')) return accept('document', 'application/rtf')
  const utf16 = startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])
  if (!utf16 && looksBinary(b)) return BINARY
  if (!utf16 && isEmail(b.subarray(0, CLASSIFY_BYTES).toString('latin1')))
    return accept('document', 'message/rfc822')
  return accept('text', 'text/plain')
}

/** Reads `length` bytes of the file at `position`. */
export type ReadAt = (position: number, length: number) => Promise<Buffer>

/**
 * classifyAttachment over a whole file of `size` bytes, read with `read`: its first
 * CLASSIFY_BYTES, then whatever more of its start and end it asks for (bounded by
 * CLASSIFY_MAX_BYTES at each end). Refused when it asks for nothing new.
 */
export async function classifyFile(
  size: number,
  read: ReadAt,
): Promise<Extract<Classification, { ok: true }> | typeof BINARY> {
  let headLength = Math.min(size, CLASSIFY_BYTES)
  let tailLength = 0
  for (let round = 0; round < 4; round++) {
    const head = await read(0, headLength)
    const tail = tailLength > 0 ? await read(size - tailLength, tailLength) : Buffer.alloc(0)
    const result = classifyAttachment({ head, tail, size })
    if (result.ok) return result
    if (result.code !== 'need-more') break
    const nextHead = Math.min(size, CLASSIFY_MAX_BYTES, Math.max(headLength, result.head ?? 0))
    const nextTail = Math.min(size, CLASSIFY_MAX_BYTES, Math.max(tailLength, result.tail ?? 0))
    if (nextHead === headLength && nextTail === tailLength) break
    headLength = nextHead
    tailLength = nextTail
  }
  return BINARY
}

/** The most bytes a file of each kind may have (before an image is scaled down). */
export const KIND_LIMITS: Readonly<Record<AttachmentKind, number>> = {
  text: ATTACHMENT_LIMITS.textBytes,
  image: ATTACHMENT_LIMITS.imageBytes,
  pdf: ATTACHMENT_LIMITS.pdfBytes,
  document: ATTACHMENT_LIMITS.documentBytes,
}

/** Bigger than any kind accepts: refused before reading anything. */
export const MAX_ATTACHMENT_BYTES = Math.max(...Object.values(KIND_LIMITS))
