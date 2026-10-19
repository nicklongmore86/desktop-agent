// The attachment blob store: userData/attachments/<sha256>, one file per distinct
// content. Ids are validated against ATTACHMENT_ID_PATTERN before they are ever
// joined to a path, so nothing the renderer or a saved chat sends can name another
// file. Writes go to a temp file (owner-only) and are renamed into place, so a
// crash never leaves a partial blob under a valid id.
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ATTACHMENT_ID_PATTERN } from '../../shared/attachments'

/** What the saved-chat code (PR 2) may use; it never writes blobs itself. */
export interface AttachmentStoreLike {
  has(id: string): Promise<boolean>
  release?(ids: string[]): Promise<void>
}

export function isAttachmentId(id: unknown): id is string {
  return typeof id === 'string' && ATTACHMENT_ID_PATTERN.test(id)
}

export function attachmentId(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const TEMP_SUFFIX = '.tmp'

export class AttachmentStore implements AttachmentStoreLike {
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
        // A concurrent put of the same content won (on Windows the rename can then fail
        // while the other copy is open): the same bytes are already stored under this id.
        if (!(await this.has(id))) throw error
      }
    } finally {
      // Best effort: after a successful rename there is nothing left to remove.
      await fs.rm(temp, { force: true }).catch(() => {})
    }
    return id
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
   * Deletes blobs. Content-addressed: the caller must only release ids that nothing
   * it keeps (any saved chat) still refers to. Invalid ids are ignored.
   */
  async release(ids: string[]): Promise<void> {
    await Promise.all(ids.filter(isAttachmentId).map((id) => fs.rm(this.file(id), { force: true })))
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
    for (const name of names) {
      const isTemp = name.startsWith('.') && name.endsWith(TEMP_SUFFIX)
      if (!isTemp && (!isAttachmentId(name) || keep(name))) continue
      const file = path.join(this.dir, name)
      try {
        const stats = await fs.lstat(file)
        if (!stats.isFile() || now - stats.mtimeMs < minAgeMs) continue
        await fs.rm(file, { force: true })
        if (!isTemp) removed.push(name)
      } catch {
        // Gone already, or not ours to remove.
      }
    }
    return removed
  }
}
