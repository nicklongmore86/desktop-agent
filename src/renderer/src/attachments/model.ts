import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentRef,
} from '../../../shared/attachments'
import type { AttachErrorCode, AttachOutcome } from '../../../shared/ipc-attachments'
import type { ConnectionId } from '../../../shared/ipc-connections'

/** An attachment waiting in the composer. `outsideGrant`: a one-time snapshot of a file outside the granted folders. */
export interface StagedAttachment {
  attachment: AttachmentRef
  outsideGrant: boolean
}

/** Shown on a chip the current connection cannot receive yet. */
export const NOT_SENT_YET = 'Not sent to this model yet; it will see the file name only.'

/** The per-message limits (ATTACHMENT_LIMITS), as the composer words them. */
export const TOO_MANY_FILES = `You can attach up to ${String(ATTACHMENT_LIMITS.maxPerMessage)} files to a message.`
export const TOO_MUCH_DATA = `A message can carry up to ${String(ATTACHMENT_LIMITS.messageBytes / (1024 * 1024))} MB of attachments.`

/**
 * Whether `kind` reaches the model through `connection`. Today every provider gets text
 * files inline and PDFs converted to text by the document reader (with drawn pages as
 * images where the connection takes them), and only the file name for images and
 * documents (placeholders until per-provider translators land), so this does not depend
 * on the connection yet.
 */
export function canReceive(kind: AttachmentKind, _connection?: ConnectionId | null): boolean {
  return kind === 'text' || kind === 'pdf'
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
