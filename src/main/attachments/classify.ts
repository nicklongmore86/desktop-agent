// What kind of attachment some bytes are, and whether they are accepted at all.
// The one place that decides it: the validator and the store never look at
// content. A new kind (e.g. Office documents) is added here and in KIND_LIMITS.
import { ATTACHMENT_LIMITS, type AttachmentKind } from '../../shared/attachments'
import { looksBinary } from '../tools/text'

/** How many leading bytes classifyAttachment looks at (read_file's binary sniff window). */
export const CLASSIFY_BYTES = 8000

export type Classification =
  | { ok: true; kind: AttachmentKind; mime: string }
  /** Not an image, PDF or text: zip, exe, Office files and other binaries are refused. */
  | { ok: false; code: 'binary' }

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((byte, i) => bytes[at + i] === byte)

const ascii = (text: string): number[] => Array.from(Buffer.from(text, 'latin1'))

/** Image signatures every provider that takes images accepts. */
const IMAGE_SIGNATURES: readonly { mime: string; test: (b: Uint8Array) => boolean }[] = [
  {
    mime: 'image/png',
    test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: 'image/jpeg', test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    mime: 'image/gif',
    test: (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  },
  {
    mime: 'image/webp',
    test: (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  },
]

/**
 * Classifies a file by its first bytes (at least CLASSIFY_BYTES of them when the
 * file is that long): images and PDFs by signature, never by name or claimed MIME
 * type; anything else is text unless read_file's binary check (`looksBinary`: a NUL
 * byte or many control characters) says otherwise. UTF-16 text with a byte-order
 * mark counts as text, as it does for read_file.
 */
export function classifyAttachment(head: Uint8Array): Classification {
  for (const signature of IMAGE_SIGNATURES)
    if (signature.test(head)) return { ok: true, kind: 'image', mime: signature.mime }
  if (startsWith(head, ascii('%PDF-'))) return { ok: true, kind: 'pdf', mime: 'application/pdf' }
  const utf16 = startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])
  if (!utf16 && looksBinary(head)) return { ok: false, code: 'binary' }
  return { ok: true, kind: 'text', mime: 'text/plain' }
}

/** The most bytes a file of each kind may have (before an image is scaled down). */
export const KIND_LIMITS: Readonly<Record<AttachmentKind, number>> = {
  text: ATTACHMENT_LIMITS.textBytes,
  image: ATTACHMENT_LIMITS.imageBytes,
  pdf: ATTACHMENT_LIMITS.pdfBytes,
}

/** Bigger than any kind accepts: refused before reading anything. */
export const MAX_ATTACHMENT_BYTES = Math.max(...Object.values(KIND_LIMITS))
