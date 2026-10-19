// The attachment blob store: userData/attachments/<sha256>, one file per distinct
// content. Ids are validated against ATTACHMENT_ID_PATTERN before they are ever
// joined to a path, so nothing the renderer or a saved chat sends can name another
// file. Writes go to a temp file (owner-only) and are renamed into place, so a
// crash never leaves a partial blob under a valid id.
//
// Next to each blob, `<id>.json` holds the metadata main issued for it (name, kind,
// mime, size, source). It is written the same way and validated again on every
// read; a sidecar that is malformed or does not match its blob is ignored.
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  ATTACHMENT_ID_PATTERN,
  ATTACHMENT_LIMITS,
  type AttachmentRef,
} from '../../shared/attachments'
import { ATTACHMENT_MAX_NAME } from '../../shared/ipc-attachments'
import { hasUnsafeReferenceChars } from '../files/actions'

/** What the saved-chat code (PR 2) may use; it never writes blobs itself. */
export interface AttachmentStoreLike {
  has(id: string): Promise<boolean>
  release?(ids: string[]): Promise<void>
}

/** What the conversation and provider code use: blobs, their metadata, and issued ids. */
export interface AttachmentBlobs {
  has(id: string): Promise<boolean>
  read(id: string): Promise<Uint8Array | null>
  release(ids: string[]): Promise<void>
  describe(id: string): Promise<AttachmentRef | null>
  isIssued(id: string): boolean
}

const SIDECAR = '.json'
/** A sidecar bigger than this is not read. */
const MAX_SIDECAR_BYTES = 4096
const idSchema = z.string().regex(ATTACHMENT_ID_PATTERN)
const count = z.number().int().nonnegative().max(1e9)
const refSchema = z.strictObject({
  id: idSchema,
  name: z
    .string()
    .min(1)
    .max(ATTACHMENT_MAX_NAME)
    .refine((name) => !hasUnsafeReferenceChars(name)),
  kind: z.enum(['text', 'image', 'pdf', 'document']),
  mime: z
    .string()
    .max(200)
    .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
  size: z.number().int().nonnegative().max(ATTACHMENT_LIMITS.documentBytes),
  source: z
    .strictObject({
      id: idSchema,
      page: z.number().int().positive().max(100_000).optional(),
      region: z.strictObject({ x: count, y: count, width: count, height: count }).optional(),
    })
    .optional(),
})

/** Validates metadata as main would issue it; null for anything else. */
export function parseAttachmentRef(value: unknown): AttachmentRef | null {
  const parsed = refSchema.safeParse(value)
  if (!parsed.success) return null
  const { source, ...ref } = parsed.data
  if (!source) return ref
  const { page, region, id } = source
  return {
    ...ref,
    source: {
      id,
      ...(page === undefined ? {} : { page }),
      ...(region === undefined ? {} : { region }),
    },
  }
}

export function isAttachmentId(id: unknown): id is string {
  return typeof id === 'string' && ATTACHMENT_ID_PATTERN.test(id)
}

export function attachmentId(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const TEMP_SUFFIX = '.tmp'

export class AttachmentStore implements AttachmentStoreLike, AttachmentBlobs {
  /** Ids issued to the renderer this session (plus ids registered from saved chats). */
  private readonly issued = new Set<string>()

  constructor(readonly dir: string) {}

  /** The blob's path. Throws for anything that is not a valid id. */
  private file(id: string): string {
    if (!isAttachmentId(id)) throw new Error('Unknown attachment.')
    return path.join(this.dir, id)
  }

  /** Stores `bytes` and returns their id. Storing the same content twice keeps one file. */
  async put(bytes: Uint8Array): Promise<string> {
    const id = attachmentId(bytes)
    const file = this.file(id)
    if (await this.has(id)) return id
    // A concurrent put of the same content may win (on Windows the rename can then fail
    // while the other copy is open): the same bytes are already stored under this id.
    await this.writeAtomic(id, file, bytes, () => this.has(id))
    return id
  }

  /** Writes `bytes` to a temp file (owner-only) in the store and renames it to `file`. */
  private async writeAtomic(
    id: string,
    file: string,
    bytes: Uint8Array,
    renameFailureOk: () => Promise<boolean>,
  ): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const temp = path.join(this.dir, `.${id}.${randomUUID()}${TEMP_SUFFIX}`)
    try {
      const handle = await fs.open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await fs.rename(temp, file)
      } catch (error) {
        if (!(await renameFailureOk())) throw error
      }
    } finally {
      // Best effort: after a successful rename there is nothing left to remove.
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  }

  /**
   * Stores bytes with the metadata main issues for them, and marks the id issued to the
   * renderer. The same content stored under another name keeps one blob; its sidecar
   * holds the most recent metadata.
   */
  async issue(bytes: Uint8Array, meta: Omit<AttachmentRef, 'id' | 'size'>): Promise<AttachmentRef> {
    const id = await this.put(bytes)
    const ref = parseAttachmentRef({ ...meta, id, size: bytes.byteLength })
    if (!ref) throw new Error('Invalid attachment metadata.')
    const data = Buffer.from(`${JSON.stringify(ref)}\n`, 'utf8')
    await this.writeAtomic(id, this.sidecar(id), data, () => Promise.resolve(false))
    this.issued.add(id)
    return ref
  }

  /**
   * The metadata main issued for a stored blob, or null when the blob is missing or the
   * sidecar is missing, too big, malformed, or does not match the blob (id and size).
   */
  async describe(id: string): Promise<AttachmentRef | null> {
    if (!isAttachmentId(id)) return null
    try {
      const [blob, sidecar] = await Promise.all([
        fs.lstat(this.file(id)),
        fs.lstat(this.sidecar(id)),
      ])
      if (!blob.isFile() || !sidecar.isFile() || sidecar.size > MAX_SIDECAR_BYTES) return null
      const ref = parseAttachmentRef(JSON.parse(await fs.readFile(this.sidecar(id), 'utf8')))
      return ref && ref.id === id && ref.size === blob.size ? ref : null
    } catch {
      return null
    }
  }

  /** True only for ids this app session issued to the renderer, or registered from saved chats. */
  isIssued(id: string): boolean {
    return isAttachmentId(id) && this.issued.has(id)
  }

  /** Registers ids referenced by saved chats (loaded by the conversation code). */
  registerIssued(ids: readonly string[]): void {
    for (const id of ids) if (isAttachmentId(id)) this.issued.add(id)
  }

  private sidecar(id: string): string {
    return `${this.file(id)}${SIDECAR}`
  }

  async has(id: string): Promise<boolean> {
    if (!isAttachmentId(id)) return false
    try {
      return (await fs.lstat(this.file(id))).isFile()
    } catch {
      return false
    }
  }

  /**
   * The blob's bytes, or null when it is missing, not a plain file, or no longer
   * matches its id (changed on disk).
   */
  async read(id: string): Promise<Buffer | null> {
    if (!(await this.has(id))) return null
    let bytes: Buffer
    try {
      bytes = await fs.readFile(this.file(id), { flag: 'r' })
    } catch {
      return null
    }
    return attachmentId(bytes) === id ? bytes : null
  }

  /**
   * Deletes the blobs outright; there is no reference counting. The store is
   * content-addressed, so the same bytes attached in two chats (or twice in one) are
   * ONE blob under one id: releasing that id removes it for every chat. Callers must
   * only pass ids that no saved chat references any more. Invalid ids are ignored.
   */
  async release(ids: string[]): Promise<void> {
    await Promise.all(
      ids.filter(isAttachmentId).flatMap((id) => {
        this.issued.delete(id)
        return [fs.rm(this.file(id), { force: true }), fs.rm(this.sidecar(id), { force: true })]
      }),
    )
  }

  /**
   * Garbage collection: deletes every blob `keep` does not claim and that is older
   * than `minAgeMs` (so attachments added to a message not yet sent survive), plus
   * stale temp files. Anything else in the folder is left alone. Returns the ids removed.
   */
  async sweep(
    keep: (id: string) => boolean,
    minAgeMs: number,
    now = Date.now(),
  ): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return []
    }
    const removed: string[] = []
    const blobs = new Set(names.filter(isAttachmentId))
    for (const name of names) {
      const isTemp = name.startsWith('.') && name.endsWith(TEMP_SUFFIX)
      if (name.endsWith(SIDECAR)) {
        // A sidecar goes with its blob: removed once the blob is gone.
        const id = name.slice(0, -SIDECAR.length)
        if (isAttachmentId(id) && !blobs.has(id))
          await fs.rm(path.join(this.dir, name), { force: true }).catch(() => {})
        continue
      }
      if (!isTemp && (!isAttachmentId(name) || keep(name))) continue
      const file = path.join(this.dir, name)
      try {
        const stats = await fs.lstat(file)
        if (!stats.isFile() || now - stats.mtimeMs < minAgeMs) continue
        await fs.rm(file, { force: true })
        if (!isTemp) {
          removed.push(name)
          this.issued.delete(name)
          await fs.rm(this.sidecar(name), { force: true })
        }
      } catch {
        // Gone already, or not ours to remove.
      }
    }
    return removed
  }
}
