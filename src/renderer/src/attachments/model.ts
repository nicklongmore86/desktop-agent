import {
  ATTACHMENT_LIMITS,
  CONVERTIBLE_PHOTO_MIMES,
  HEIC_MIMES,
  READABLE_DOCUMENT_MIMES,
  type AttachmentKind,
  type AttachmentRef,
  type HeicSupport,
} from '../../../shared/attachments'
import type { AttachErrorCode, AttachOutcome } from '../../../shared/ipc-attachments'

/** An attachment waiting in the composer. `outsideGrant`: a one-time snapshot of a file outside the granted folders. */
export interface StagedAttachment {
  attachment: AttachmentRef
  outsideGrant: boolean
}

/** Shown on a chip the current connection cannot receive yet. */
export const NOT_SENT_YET = 'Not sent to this model yet; it will see the file name only.'
/** Shown on an image chip when the connection's model cannot see images. */
export const NO_VISION =
  'This model can’t see images; it will see the file name only. Switch to a vision model, or turn on “This model can see images” in Settings if it is one.'

/** Shown on a HEIC chip until main has said whether this computer can decode HEIC. */
export const HEIC_CHECKING = 'Checking whether this computer can decode HEIC photos…'

/** The per-message limits (ATTACHMENT_LIMITS), as the composer words them. */
export const TOO_MANY_FILES = `You can attach up to ${String(ATTACHMENT_LIMITS.maxPerMessage)} files to a message.`
export const TOO_MUCH_DATA = `A message can carry up to ${String(ATTACHMENT_LIMITS.messageBytes / (1024 * 1024))} MB of attachments.`

/**
 * Whether `kind` reaches the model: text files always (inline); PDFs always, as the
 * text the document reader extracts (drawn pages go as images only to a vision model,
 * a note otherwise); Word, Excel, PowerPoint and OpenDocument files (by `mime`,
 * READABLE_DOCUMENT_MIMES) always, as their text; images when the connection's model can
 * see them (`vision`, from main); AVIF photos likewise, converted, and HEIC/HEIF photos
 * when this computer can also decode them (`heic`, from main; null while unknown). Other
 * documents are still sent as their names only.
 */
export function canReceive(
  kind: AttachmentKind,
  vision = false,
  mime = '',
  heic: HeicSupport | null = null,
): boolean {
  return (
    kind === 'text' ||
    kind === 'pdf' ||
    (kind === 'document' && READABLE_DOCUMENT_MIMES.has(mime)) ||
    (kind === 'image' && vision) ||
    (kind === 'document' &&
      vision &&
      CONVERTIBLE_PHOTO_MIMES.has(mime) &&
      (!HEIC_MIMES.has(mime) || heic?.supported === true))
  )
}

/** The tooltip for a chip the model will not receive, or undefined when it will. */
export function notReceivedNote(
  kind: AttachmentKind,
  vision = false,
  mime = '',
  heic: HeicSupport | null = null,
): string | undefined {
  if (canReceive(kind, vision, mime, heic)) return undefined
  if (kind === 'image') return NO_VISION
  if (kind === 'document' && CONVERTIBLE_PHOTO_MIMES.has(mime)) {
    if (!vision) return NO_VISION
    if (!heic) return HEIC_CHECKING
    if (!heic.supported) return `${heic.reason} Until then the model sees the file name only.`
  }
  return NOT_SENT_YET
}

/** A short, readable file size: 1.2 KB, 3 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
  return `${text} ${units[unit] ?? 'GB'}`
}

/**
 * Shortens `name` to at most `max` characters by cutting out the middle, so the start
 * and the extension both stay visible. Counts code points, never splits a surrogate pair.
 */
export function middleTruncate(name: string, max = 28): string {
  const chars = Array.from(name)
  if (chars.length <= max) return name
  const tail = Math.min(10, Math.floor((max - 1) / 2))
  const head = max - 1 - tail
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

/** The message for a refused file, by code. `reason` is main's wording, used when it adds something. */
export function refusalMessage(code: AttachErrorCode, reason: string, name?: string): string {
  const of = name ? ` “${name}”` : ''
  switch (code) {
    case 'secret':
      return reason || `Secret files${of} are never attached.`
    case 'blocked':
      return `${name ?? 'This file'} is in a protected location and cannot be attached.`
    case 'too-large':
      return reason || `${name ?? 'This file'} is too large to attach.`
    case 'binary':
      return reason || `${name ?? 'This file'} is a type that cannot be attached.`
    case 'link':
      return `Links and shortcuts cannot be attached. Attach the file itself.`
    case 'grant-folder':
      return 'Folders outside your granted folders cannot be attached. Add it in Settings → Folders.'
    case 'too-many':
      return TOO_MANY_FILES
    case 'not-found':
      return `${name ?? 'That file'} could not be found.`
    case 'invalid':
      return reason || `${name ?? 'That item'} is not a file on disk, so it cannot be attached.`
    case 'failed':
      return reason || 'Could not attach the file.'
  }
}

export interface Admission {
  /** The staged list after the new files; unchanged for any that did not fit. */
  staged: StagedAttachment[]
  /** Why files were not added (limits, not main's refusals). */
  refusals: string[]
}

/**
 * Adds attachment outcomes to the staged list, enforcing the per-message limits (count and
 * total bytes) before send. A file already staged (same content, so same id) is skipped.
 */
export function admit(
  staged: readonly StagedAttachment[],
  added: readonly StagedAttachment[],
): Admission {
  const next = [...staged]
  const refusals: string[] = []
  let total = next.reduce((sum, item) => sum + item.attachment.size, 0)
  for (const item of added) {
    if (next.some((existing) => existing.attachment.id === item.attachment.id)) continue
    if (next.length >= ATTACHMENT_LIMITS.maxPerMessage) {
      refusals.push(TOO_MANY_FILES)
      continue
    }
    if (total + item.attachment.size > ATTACHMENT_LIMITS.messageBytes) {
      refusals.push(TOO_MUCH_DATA)
      continue
    }
    next.push(item)
    total += item.attachment.size
  }
  return { staged: next, refusals }
}

export interface SortedOutcomes {
  attachments: StagedAttachment[]
  /** `@"path"` references to put into the message text. */
  references: string[]
  refusals: { code: AttachErrorCode; message: string }[]
}

/** Splits main's outcomes into chips, references and refusals. `names`: the file name for each outcome, if known. */
export function sortOutcomes(
  outcomes: readonly AttachOutcome[],
  names: readonly (string | undefined)[] = [],
): SortedOutcomes {
  const sorted: SortedOutcomes = { attachments: [], references: [], refusals: [] }
  outcomes.forEach((outcome, index) => {
    if (!outcome.ok) {
      sorted.refusals.push({
        code: outcome.code,
        message: refusalMessage(outcome.code, outcome.reason, names[index]),
      })
    } else if (outcome.kind === 'reference') sorted.references.push(outcome.text)
    else
      sorted.attachments.push({
        attachment: outcome.attachment,
        outsideGrant: outcome.outsideGrant,
      })
  })
  return sorted
}

/** One toast line for several refusals: the first, and how many more there were. */
export function summarizeRefusals(messages: readonly string[]): string | null {
  const unique = [...new Set(messages)]
  const [first] = unique
  if (first === undefined) return null
  return unique.length === 1
    ? first
    : `${first} (and ${String(unique.length - 1)} more not attached)`
}

export function totalBytes(staged: readonly StagedAttachment[]): number {
  return staged.reduce((sum, item) => sum + item.attachment.size, 0)
}
