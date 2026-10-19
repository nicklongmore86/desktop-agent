import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import {
  ATTACHMENT_ID_PATTERN,
  ATTACHMENT_LIMITS,
  MODEL_IMAGE_MIMES,
  type AttachmentKind,
  type AttachmentRef,
} from '../../shared/attachments'
import { readJsonFile, removeFile, writeJsonFile } from './json-file'
import { sanitizeTitle } from './plain-text'

/**
 * A file the user attached to a prompt. Only the reference is saved here; the
 * bytes live in the attachment store under `id`. No model API accepts this
 * block: the chat session turns it into text before a run (chat/attachments.ts).
 */
export interface AttachmentBlock extends AttachmentRef {
  type: 'attachment'
}

export type StoredBlock = ContentBlockParam | AttachmentBlock

/** A saved message: Messages-API content, plus attachment blocks in user prompts. */
export interface StoredMessage {
  role: MessageParam['role']
  content: string | StoredBlock[]
}

interface ConversationFile {
  version: 1
  messages: StoredMessage[]
}

export interface ConversationStore {
  /** The saved history, or an empty one plus `error` when the file cannot be read. */
  load: () => Promise<{ messages: StoredMessage[]; error: string | null }>
  save: (messages: StoredMessage[]) => Promise<void>
  clear: () => Promise<void>
}

type Obj = Record<string, unknown>

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

function isTextBlock(block: Obj): boolean {
  return (
    nonEmpty(block['text']) &&
    (block['citations'] === undefined ||
      block['citations'] === null ||
      Array.isArray(block['citations']))
  )
}

function isToolUse(block: Obj): boolean {
  return nonEmpty(block['id']) && nonEmpty(block['name']) && isObject(block['input'])
}

function isToolResult(block: Obj): boolean {
  const { content, is_error: isError } = block
  return (
    nonEmpty(block['tool_use_id']) &&
    (content === undefined ||
      typeof content === 'string' ||
      (Array.isArray(content) &&
        content.every(
          (part) => isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string',
        ))) &&
    (isError === undefined || typeof isError === 'boolean')
  )
}

/** The longest attachment name kept (a file name, as most file systems allow). */
export const MAX_ATTACHMENT_NAME = 255

const REQUIRED_KEYS = ['id', 'name', 'kind', 'mime', 'size']
const OPTIONAL_KEYS = ['source']
const KIND_BYTES = new Map<string, number>([
  ['text', ATTACHMENT_LIMITS.textBytes],
  ['image', ATTACHMENT_LIMITS.imageBytes],
  ['pdf', ATTACHMENT_LIMITS.pdfBytes],
  ['document', ATTACHMENT_LIMITS.documentBytes],
])
const IMAGE_MIMES: ReadonlySet<string> = new Set(MODEL_IMAGE_MIMES)
/** Files that need converting before a model can read them: Office, OpenDocument, RTF, mail, other images. */
const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/rtf',
  'text/rtf',
  'message/rfc822',
  'application/vnd.ms-outlook',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/bmp',
])
const DOCUMENT_MIME_PREFIXES = [
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.ms-word.',
  'application/vnd.ms-excel.',
  'application/vnd.ms-powerpoint.',
  'application/vnd.oasis.opendocument.',
]
// type/subtype, RFC 6838 characters only: no parameters, spaces or quotes.
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/

/**
 * A safe display name: what `sanitizeTitle` would keep unchanged (no controls,
 * bidi or zero-width characters, single spaces, trimmed), within the length
 * limit, and a base name (no path separators).
 */
export function isAttachmentName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '' &&
    !/[\\/]/.test(name) &&
    sanitizeTitle(name, MAX_ATTACHMENT_NAME) === name
  )
}

/** Exactly `required`, plus any of `optional`: no other fields. */
function hasKeys(value: Obj, required: readonly string[], optional: readonly string[]): boolean {
  const keys = Object.keys(value)
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

const isMeasure = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Where a derived attachment came from: an id, and optionally a page and region of it. */
function isSource(value: unknown, own: unknown): boolean {
  if (!isObject(value) || !hasKeys(value, ['id'], ['page', 'region'])) return false
  const { id, page, region } = value
  return (
    typeof id === 'string' &&
    ATTACHMENT_ID_PATTERN.test(id) &&
    id !== own &&
    (page === undefined || (Number.isSafeInteger(page) && (page as number) > 0)) &&
    (region === undefined ||
      (isObject(region) &&
        hasKeys(region, ['x', 'y', 'width', 'height'], []) &&
        Object.values(region).every(isMeasure)))
  )
}

/** An attachment's metadata, exactly: no other fields, every value within the limits. */
export function isAttachmentRef(value: unknown, type?: 'attachment'): value is AttachmentRef {
  if (!isObject(value)) return false
  const required = type === undefined ? REQUIRED_KEYS : [...REQUIRED_KEYS, 'type']
  if (!hasKeys(value, required, OPTIONAL_KEYS)) return false
  if (value['type'] !== type) return false
  const { id, name, kind, mime, size, source } = value
  const max = typeof kind === 'string' ? KIND_BYTES.get(kind) : undefined
  return (
    typeof id === 'string' &&
    ATTACHMENT_ID_PATTERN.test(id) &&
    isAttachmentName(name) &&
    max !== undefined &&
    typeof mime === 'string' &&
    MIME.test(mime) &&
    mimeFits(kind as AttachmentKind, mime) &&
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    size <= max &&
    (source === undefined || isSource(source, id))
  )
}

function mimeFits(kind: AttachmentKind, mime: string): boolean {
  if (kind === 'image') return IMAGE_MIMES.has(mime)
  if (kind === 'pdf') return mime === 'application/pdf'
  if (kind === 'document')
    return DOCUMENT_MIMES.has(mime) || DOCUMENT_MIME_PREFIXES.some((p) => mime.startsWith(p))
  return true
}

const isAttachmentBlock = (block: Obj): boolean => isAttachmentRef(block, 'attachment')

/**
 * A prompt's attachments, as a whole: at most `maxPerMessage`, no id twice,
 * `messageBytes` in all, and never next to tool results (only a prompt carries them).
 */
export function attachmentsFit(attachments: readonly AttachmentRef[]): boolean {
  return (
    attachments.length <= ATTACHMENT_LIMITS.maxPerMessage &&
    new Set(attachments.map((attachment) => attachment.id)).size === attachments.length &&
    attachments.reduce((total, attachment) => total + attachment.size, 0) <=
      ATTACHMENT_LIMITS.messageBytes
  )
}

/** The attachment blocks of a message, in order. */
export function attachmentsOf(message: StoredMessage): AttachmentBlock[] {
  if (typeof message.content === 'string') return []
  return message.content.filter((block) => block.type === 'attachment')
}

/**
 * Every attachment id referenced anywhere in `value`, read loosely: used to
 * decide which stored files are still needed, so a file this version cannot
 * load (or a newer version wrote) still counts.
 */
export function attachmentIdsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) attachmentIdsIn(item, into)
  } else if (isObject(value)) {
    const id = value['id']
    if (value['type'] === 'attachment' && typeof id === 'string' && ATTACHMENT_ID_PATTERN.test(id))
      into.add(id)
    for (const item of Object.values(value)) attachmentIdsIn(item, into)
  }
  return into
}

/**
 * The blocks each role may hold, checked by discriminant. Maps, not object
 * literals: an untrusted `type` like "toString" or "__proto__" must never
 * reach an inherited property. Anything not listed is rejected.
 */
const BLOCK_CHECKS = new Map<string, ReadonlyMap<string, (block: Obj) => boolean>>([
  [
    'user',
    new Map([
      ['text', isTextBlock],
      ['tool_result', isToolResult],
      ['attachment', isAttachmentBlock],
    ]),
  ],
  [
    'assistant',
    new Map([
      ['text', isTextBlock],
      ['tool_use', isToolUse],
    ]),
  ],
])

function isMessage(value: unknown): value is StoredMessage {
  if (!isObject(value)) return false
  const { role, content } = value
  const checks = typeof role === 'string' ? BLOCK_CHECKS.get(role) : undefined
  if (!checks) return false
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content) || content.length === 0) return false
  const valid = content.every((block) => {
    if (!isObject(block)) return false
    const type = block['type']
    const check = typeof type === 'string' ? checks.get(type) : undefined
    return check !== undefined && check(block)
  })
  if (!valid) return false
  const message = value as unknown as StoredMessage
  const attachments = attachmentsOf(message)
  return (
    attachments.length === 0 ||
    (attachmentsFit(attachments) && blockIds(message, 'tool_result').length === 0)
  )
}

function blockIds(message: StoredMessage, type: 'tool_use' | 'tool_result'): string[] {
  if (typeof message.content === 'string') return []
  return message.content.flatMap((block) =>
    block.type === 'tool_use' && type === 'tool_use'
      ? [block.id]
      : block.type === 'tool_result' && type === 'tool_result'
        ? [block.tool_use_id]
        : [],
  )
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id))

/**
 * Basic structure the API requires: the history starts with the user, and
 * every assistant tool call is answered, exactly, by the next user message.
 * Consecutive user (a failed run) or assistant (pause_turn) messages are allowed.
 */
export function isWellFormed(messages: readonly StoredMessage[]): boolean {
  if (messages.length > 0 && messages[0]?.role !== 'user') return false
  return messages.every((message, index) => {
    const previous = messages[index - 1]
    const next = messages[index + 1]
    const calls = blockIds(message, 'tool_use')
    const results = blockIds(message, 'tool_result')
    if (results.length > 0) {
      if (previous?.role !== 'assistant' || !sameSet(results, blockIds(previous, 'tool_use')))
        return false
    }
    if (calls.length > 0) {
      if (next?.role !== 'user' || !sameSet(calls, blockIds(next, 'tool_result'))) return false
    }
    return true
  })
}

function isConversationFile(value: unknown): value is ConversationFile {
  if (!isObject(value)) return false
  const { version, messages } = value
  return (
    version === 1 && Array.isArray(messages) && messages.every(isMessage) && isWellFormed(messages)
  )
}

/** The current conversation (Messages-API history) as JSON in userData. */
export function createConversationStore(file: string): ConversationStore {
  return {
    async load() {
      try {
        const parsed = await readJsonFile(file)
        if (parsed === undefined) return { messages: [], error: null }
        if (isConversationFile(parsed)) return { messages: parsed.messages, error: null }
      } catch {
        // Fall through: an unreadable file means a fresh conversation, not a crash.
      }
      return {
        messages: [],
        error: 'The saved conversation could not be read, so a new one was started.',
      }
    },
    save: (messages) => writeJsonFile(file, { version: 1, messages } satisfies ConversationFile),
    clear: () => removeFile(file),
  }
}
