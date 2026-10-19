// Attachments as main provides them: a dropped or picked path, or pasted bytes,
// becomes either an `@"path"` reference (text files and folders inside a grant) or
// a snapshot in the blob store that the renderer knows only by id. Every attempt,
// accepted or refused, is one audit entry (`tool: 'attach'`, `origin: 'user'`),
// with no file contents.
import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentRef,
} from '../../shared/attachments'
import {
  ATTACHMENT_MAX_NAME,
  type AttachOutcome,
  type AttachVia,
  type CopyIntoFolderResult,
} from '../../shared/ipc-attachments'
import type { FileLocation } from '../../shared/ipc-files'
import type { AttachmentsService } from '../ipc-attachments'
import {
  BIDI_CONTROLS,
  hasUnsafeReferenceChars,
  referenceFor,
  SECRET_REFERENCE,
} from '../files/actions'
import { CONTROL_CHARS, resolveLocation, rootId } from '../files/location'
import { isSecretName } from '../files/secret-names'
import type { AuditSink } from '../permissions/audit'
import { blocklistReason } from '../permissions/blocklist'
import type { PathGuard } from '../permissions/guard'
import { defineTool } from '../tools/define'
import { decodeText } from '../tools/text'
import type { AgentTool, ToolResult } from '../tools/types'
import {
  CLASSIFY_BYTES,
  CLASSIFY_MAX_BYTES,
  classifyAttachment,
  KIND_LIMITS,
  MAX_ATTACHMENT_BYTES,
  type Classification,
} from './classify'
import { copyIntoFolderTool, type AttachmentSourceRecord } from './copy-tool'
import { prepareImage, type ImageScaler } from './image'
import { pdfPageCount } from './pdf'
import { attachmentId, isAttachmentId, type AttachmentStore } from './store'
import { checkSource, openChecked, readUpTo, refuse, type Refusal } from './validate'

export interface AttachmentsServiceDeps {
  guard: PathGuard
  store: AttachmentStore
  audit: AuditSink
  scaler: ImageScaler
  /** Shows the native multi-select file picker; [] when cancelled. */
  pickFiles: () => Promise<string[]>
  /**
   * Runs a user-requested tool call with the chat's approval prompts (ChatSession.runUserAction).
   * Rejects or returns an error result when the chat is busy.
   */
  runUserAction: (tool: AgentTool, input: unknown) => Promise<ToolResult>
  now?: () => number
  onAuditFailure?: (error: unknown) => void
}

/** Ids issued this session that "Copy into folder…" can still use; the oldest are forgotten first. */
const MAX_REMEMBERED = 500

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.ms-outlook': 'msg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'message/rfc822': 'eml',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
}

/** What the audit entry records about an attempt (never contents). */
interface AuditFacts {
  kind?: AttachmentKind | 'folder'
  mime?: string
  size?: number
  inGrant?: boolean
  paths: string[]
}

type Attempt = { outcome: AttachOutcome; facts: AuditFacts }

/** A name the UI can show as plain text: no control or bidi characters, bounded length. */
export function displayName(name: string): string {
  const clean = name
    .replace(new RegExp(CONTROL_CHARS.source, 'g'), '')
    .replace(new RegExp(BIDI_CONTROLS.source, 'g'), '')
    .trim()
  // Code points, not UTF-16 units, so a surrogate pair is never cut in half.
  return Array.from(clean).slice(0, ATTACHMENT_MAX_NAME).join('') || 'attachment'
}

export function createAttachmentsService(deps: AttachmentsServiceDeps): AttachmentsService {
  const { guard, store } = deps
  const now = deps.now ?? (() => performance.now())
  /** Outside-grant snapshots, for "Copy into folder…". Main only: the renderer has the id. */
  const sources = new Map<string, AttachmentSourceRecord>()
  const copyTool = defineTool(copyIntoFolderTool({ guard, source: (id) => sources.get(id) }), {
    guard,
    audit: deps.audit,
    now,
    onAuditFailure: deps.onAuditFailure ?? (() => {}),
  })

  const remember = (id: string, record: AttachmentSourceRecord): void => {
    sources.delete(id)
    sources.set(id, record)
    while (sources.size > MAX_REMEMBERED) {
      const oldest = sources.keys().next().value
      if (oldest === undefined) break
      sources.delete(oldest)
    }
  }

  const audited = async (source: AttachVia, attempt: () => Promise<Attempt>) => {
    const started = now()
    let result: Attempt
    try {
      result = await attempt()
    } catch {
      result = {
        outcome: refuse('failed', 'The file could not be attached.'),
        facts: { paths: [] },
      }
    }
    const { outcome, facts } = result
    const { paths, ...args } = facts
    try {
      await deps.audit.record({
        tool: 'attach',
        args: { source, ...args },
        paths,
        approval: 'auto',
        origin: 'user',
        outcome: outcome.ok ? 'ok' : 'error',
        ...(outcome.ok ? {} : { error: outcome.code }),
        durationMs: Math.max(0, Math.round(now() - started)),
      })
    } catch (error) {
      deps.onAuditFailure?.(error)
    }
    return outcome
  }

  /** Classifies, checks the per-kind limits, prepares and stores a snapshot. */
  async function snapshot(
    bytes: Buffer,
    name: string,
    kind: AttachmentKind,
    mime: string,
  ): Promise<{ ok: true; ref: AttachmentRef } | Refusal> {
    if (bytes.length > KIND_LIMITS[kind]) return tooLarge(kind)
    let stored = bytes
    let storedMime = mime
    if (kind === 'text') {
      const decoded = decodeText(bytes)
      if (decoded.binary) return refuse('binary', 'Binary files cannot be attached.')
      stored = Buffer.from(decoded.text, 'utf8')
      if (stored.length > KIND_LIMITS.text) return tooLarge('text')
    } else if (kind === 'image') {
      const prepared = await prepareImage(bytes, mime, deps.scaler)
      if (!prepared.ok) return prepared
      stored = prepared.bytes
      storedMime = prepared.mime
    } else if (kind === 'pdf') {
      const pages = pdfPageCount(bytes)
      if (pages !== null && pages > ATTACHMENT_LIMITS.pdfMaxPages)
        return refuse(
          'too-large',
          `This PDF has ${String(pages)} pages; at most ${String(ATTACHMENT_LIMITS.pdfMaxPages)} can be attached.`,
        )
    }
    // Documents are stored as they are; extracting them is a separate step.
    const id = await store.put(stored)
    return {
      ok: true,
      ref: { id, name: displayName(name), kind, mime: storedMime, size: stored.length },
    }
  }

  async function referenceIn(root: string, path: string): Promise<AttachOutcome> {
    const rel = guard.path.relative(root, path).split(guard.path.sep).filter(Boolean).join('/')
    const result = await referenceFor(guard, { rootId: rootId(root), rel })
    return result.ok
      ? { ok: true, kind: 'reference', text: result.text }
      : refuse(result.reason === SECRET_REFERENCE ? 'secret' : 'invalid', result.reason)
  }

  async function attachPath(raw: string): Promise<Attempt> {
    const checked = await checkSource(guard, raw)
    if (!checked.ok) return { outcome: checked, facts: { paths: raw ? [raw] : [] } }
    const facts: AuditFacts = { paths: [checked.path], inGrant: checked.root !== null }
    if (checked.type === 'folder') {
      facts.kind = 'folder'
      if (checked.root === null)
        return {
          outcome: refuse(
            'grant-folder',
            'Folders outside the granted folders cannot be attached. Grant this folder in Settings → Folders first.',
          ),
          facts,
        }
      return { outcome: await referenceIn(checked.root, checked.path), facts }
    }

    facts.size = checked.size
    const handle = await openChecked(checked.path, checked.identity)
    if ('ok' in handle) return { outcome: handle, facts }
    try {
      const kind = await classify((n) => readUpTo(handle, n))
      if (!kind.ok) return { outcome: kind, facts }
      facts.kind = kind.kind
      facts.mime = kind.mime
      // Inside a grant, text is referenced, not copied: the agent reads it with its tools.
      if (kind.kind === 'text' && checked.root !== null)
        return { outcome: await referenceIn(checked.root, checked.path), facts }
      if (checked.size > Math.min(KIND_LIMITS[kind.kind], MAX_ATTACHMENT_BYTES))
        return { outcome: tooLarge(kind.kind), facts }
      const all = await readUpTo(handle, KIND_LIMITS[kind.kind])
      if (!all.whole) return { outcome: tooLarge(kind.kind), facts }
      const name = guard.path.basename(checked.path)
      const result = await snapshot(all.bytes, name, kind.kind, kind.mime)
      if (!result.ok) return { outcome: result, facts }
      facts.mime = result.ref.mime
      const outsideGrant = checked.root === null
      if (outsideGrant)
        remember(result.ref.id, {
          name: result.ref.name,
          path: checked.path,
          identity: checked.identity,
          size: all.bytes.length,
          sha256: attachmentId(all.bytes),
        })
      return {
        outcome: { ok: true, kind: 'attachment', attachment: result.ref, outsideGrant },
        facts,
      }
    } finally {
      await handle.close()
    }
  }

  async function attachPaste(bytes: Uint8Array, name: string | undefined): Promise<Attempt> {
    const facts: AuditFacts = { paths: [], inGrant: false, size: bytes.length }
    if (name !== undefined) {
      if (hasUnsafeReferenceChars(name) || /[\\/]/.test(name) || name.length > ATTACHMENT_MAX_NAME)
        return { outcome: refuse('invalid', 'This file name cannot be used.'), facts }
      if (isSecretName(name)) return { outcome: refuse('secret', SECRET_REFERENCE), facts }
      if (blocklistReason(`/${name}`, 'linux'))
        return { outcome: refuse('blocked', SECRET_REFERENCE), facts }
    }
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const kind = await classify((n) =>
      Promise.resolve({ bytes: buffer.subarray(0, n), whole: n >= buffer.length }),
    )
    if (!kind.ok) return { outcome: kind, facts }
    facts.kind = kind.kind
    facts.mime = kind.mime
    const fallback = `Pasted ${kind.kind === 'pdf' ? 'PDF' : kind.kind}.${EXTENSIONS[kind.mime] ?? 'bin'}`
    const result = await snapshot(Buffer.from(buffer), name ?? fallback, kind.kind, kind.mime)
    if (!result.ok) return { outcome: result, facts }
    facts.mime = result.ref.mime
    return {
      outcome: { ok: true, kind: 'attachment', attachment: result.ref, outsideGrant: false },
      facts,
    }
  }

  return {
    attachDropped: (path) => audited('drop', () => attachPath(path)),
    async pick() {
      const paths = await deps.pickFiles()
      if (paths.length > ATTACHMENT_LIMITS.maxPerMessage)
        return [
          await audited('picker', () =>
            Promise.resolve({
              outcome: refuse(
                'too-many',
                `Choose at most ${String(ATTACHMENT_LIMITS.maxPerMessage)} files at a time.`,
              ),
              facts: { paths: [] },
            }),
          ),
        ]
      const outcomes: AttachOutcome[] = []
      for (const path of paths) outcomes.push(await audited('picker', () => attachPath(path)))
      return outcomes
    },
    fromPaste: (bytes, _mime, name) => audited('paste', () => attachPaste(bytes, name)),
    async copyIntoFolder(id: string, folder: FileLocation): Promise<CopyIntoFolderResult> {
      const source = isAttachmentId(id) ? sources.get(id) : undefined
      if (!source)
        return {
          ok: false,
          reason: 'Only files attached from outside the granted folders can be copied.',
        }
      const where = await resolveLocation(guard, folder)
      if (!where.ok) return { ok: false, reason: where.reason }
      if (!where.exists) return { ok: false, reason: 'That folder no longer exists.' }
      const destination = guard.path.join(where.path, source.name)
      let result: ToolResult
      try {
        result = await deps.runUserAction(copyTool, { id, destination })
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'Nothing was copied.' }
      }
      if (result.isError)
        return { ok: false, reason: result.content, ...(result.declined ? { declined: true } : {}) }
      const reference = await referenceIn(where.root, destination)
      return reference.ok && reference.kind === 'reference'
        ? { ok: true, text: reference.text }
        : { ok: false, reason: 'The file was copied, but it cannot be referenced here.' }
    },
  }
}

/**
 * classifyAttachment over the start of a file, giving it more bytes when it asks
 * (`read(n)` returns the first n bytes and whether that is the whole file).
 */
async function classify(
  read: (n: number) => Promise<{ bytes: Buffer; whole: boolean }>,
): Promise<Extract<Classification, { ok: true }> | Refusal> {
  let head = await read(CLASSIFY_BYTES)
  let result = classifyAttachment(head.bytes)
  if (!result.ok && result.code === 'need-more' && !head.whole) {
    head = await read(Math.min(result.bytes, CLASSIFY_MAX_BYTES))
    result = classifyAttachment(head.bytes)
  }
  return result.ok ? result : refuse('binary', 'This kind of file cannot be attached.')
}

function tooLarge(kind: AttachmentKind): Refusal {
  const mb = (n: number) => `${String(Math.round((n / (1024 * 1024)) * 10) / 10)} MB`
  const limit = KIND_LIMITS[kind]
  const size = limit < 1024 * 1024 ? `${String(limit / 1024)} KB` : mb(limit)
  const what = { text: 'Text files', image: 'Images', pdf: 'PDFs', document: 'Documents' }[kind]
  return refuse('too-large', `${what} can be at most ${size}.`)
}
