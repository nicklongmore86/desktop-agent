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
/** The most leading bytes classifyAttachment ever asks for (to find a container's entries). */
export const CLASSIFY_MAX_BYTES = 1024 * 1024

export type Classification =
  | { ok: true; kind: AttachmentKind; mime: string }
  /** Not an accepted kind: executables, archives and other binaries are refused. */
  | { ok: false; code: 'binary' }
  /**
   * These bytes are not enough to decide: call again with the file's first `bytes` bytes
   * (at most CLASSIFY_MAX_BYTES). If the whole file was given already, it is refused.
   */
  | { ok: false; code: 'need-more'; bytes: number }

const BINARY: Classification = { ok: false, code: 'binary' }
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
  if (b.length < 0x34) return { ok: false, code: 'need-more', bytes: 512 }
  const shift = b.readUInt16LE(0x1e)
  if (shift !== 9 && shift !== 12) return BINARY
  const sector = 1 << shift
  // The first directory sector; its first entry is the root, which carries the class id.
  const directory = (b.readUInt32LE(0x30) + 1) * sector
  if (directory + sector > CLASSIFY_MAX_BYTES) return BINARY
  if (directory + sector > b.length)
    return { ok: false, code: 'need-more', bytes: directory + sector }
  const known = OLE_CLASSES.get(classId(b, directory + 0x50))
  if (known) return accept('document', known)
  const names = b.subarray(directory, directory + sector).toString('utf16le')
  for (const [stream, mime] of OLE_STREAMS)
    if (names.includes(stream)) return accept('document', mime)
  return BINARY
}

const OOXML: readonly [string, string][] = [
  ['word/', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xl/', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt/', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]

/** Office Open XML and OpenDocument packages; any other zip (jar, apk, epub, vsix...) is refused. */
function zipDocument(b: Buffer): Classification {
  // OpenDocument: the first entry is an uncompressed `mimetype` naming the format.
  if (b.length >= 30 && b.readUInt16LE(26) === 8 && hasAscii(b, 'mimetype', 30)) {
    const start = 38 + b.readUInt16LE(28)
    const type = b.subarray(start, start + Math.min(b.readUInt32LE(18), 100)).toString('latin1')
    return type.startsWith('application/vnd.oasis.opendocument.')
      ? accept('document', type)
      : BINARY
  }
  // Office Open XML: the local entry names (the compressed data between them is skipped).
  let contentTypes = false
  for (let at = b.indexOf('PK\x03\x04', 0, 'latin1'); at !== -1 && at + 30 <= b.length;) {
    const name = b.subarray(at + 30, at + 30 + b.readUInt16LE(at + 26)).toString('latin1')
    if (name === '[Content_Types].xml') contentTypes = true
    const office = OOXML.find(([prefix]) => name.startsWith(prefix))
    if (contentTypes && office) return accept('document', office[1])
    at = b.indexOf('PK\x03\x04', at + 4, 'latin1')
  }
  return contentTypes && b.length < CLASSIFY_MAX_BYTES
    ? { ok: false, code: 'need-more', bytes: CLASSIFY_MAX_BYTES }
    : BINARY
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
 * Classifies a file by its first bytes: start with the first CLASSIFY_BYTES (or the
 * whole file), and call again with more when asked (`need-more`; containers such as
 * Office files are recognised by their entries). Text counts as text unless read_file's
 * binary check (`looksBinary`: a NUL byte or many control characters) says otherwise;
 * UTF-16 text with a byte-order mark is text, as it is for read_file.
 */
export function classifyAttachment(head: Uint8Array): Classification {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength)
  for (const image of MODEL_IMAGES) if (image.test(b)) return accept('image', image.mime)
  if (hasAscii(b, '%PDF-')) return accept('pdf', 'application/pdf')
  const image = otherImage(b)
  if (image) return accept('document', image)
  if (startsWith(b, OLE_SIGNATURE)) return oleDocument(b)
  if (hasAscii(b, 'PK\x03\x04')) return zipDocument(b)
  if (hasAscii(b, '{\\rtf')) return accept('document', 'application/rtf')
  const utf16 = startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])
  if (!utf16 && looksBinary(b)) return BINARY
  if (!utf16 && isEmail(b.subarray(0, CLASSIFY_BYTES).toString('latin1')))
    return accept('document', 'message/rfc822')
  return accept('text', 'text/plain')
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
