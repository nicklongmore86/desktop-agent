// Text extracted from documents for search_files, kept so a later search does not send
// the same files through the document reader again. It lives in the app's data folder
// (userData, which the agent's guard blocks), one folder per granted folder, and the
// folder goes when its grant does. What is read back is treated as untrusted: it is
// checked as strictly as a worker reply, and anything unexpected is deleted and missed.
import { createHash, randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { foldCase, pathApi } from '../permissions/paths'

/** Bumped whenever what is stored, or how it is extracted, changes: older entries miss. */
export const CACHE_FORMAT = 1

/** The file a cached text was extracted from, as its handle saw it when it was read. */
export interface DocumentFileKey {
  /** The granted folder the file is in (as the grant store holds it). */
  root: string
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/**
 * One run of extracted text and where it is: `at` is a page or slide ("page 3"), a sheet
 * name when `cells` is set (each line is then `A1<TAB>value`), or empty; `offset` is the
 * 1-based character of a flowing document (Word, OpenDocument text) where `text` starts.
 */
export interface TextSegment {
  at: string
  text: string
  cells?: boolean
  offset?: number
}

export interface CachedText {
  /** The reader's DocumentKind for the file (pdf, docx, xlsx, ...). */
  kind: string
  segments: TextSegment[]
  /** A PDF with pages but no text layer to speak of (scanned). */
  scanned: boolean
  /** Pages of a PDF that has text with no text layer of their own (scanned pages). */
  blankPages: number
  /** Set when the text stops before the end (the per-document limits): what was read. */
  truncated: string | null
  /** A refusal that will not change until the file does (password-protected, malformed). */
  failure: string | null
}

export interface DocumentTextCacheOptions {
  dir: string
  /** The granted folders now; an entry is only written for one of these. */
  roots: () => readonly string[]
  platform?: NodeJS.Platform
  /** Largest entry kept, serialized. Bigger texts are searched but not kept. */
  maxEntryBytes?: number
  /** All entries together; the least recently used go first. */
  maxTotalBytes?: number
  maxEntries?: number
  /** Wall clock in ms, for least-recently-used order. */
  clock?: () => number
}

export interface DocumentTextCacheLike {
  /** Builds the index from disk (once); `has` answers false until it has run. */
  load(): Promise<void>
  get(key: DocumentFileKey): Promise<CachedText | null>
  /** Whether an entry is held for `key`, without reading it (false until the index is loaded). */
  has(key: DocumentFileKey): boolean
  put(key: DocumentFileKey, value: CachedText): Promise<boolean>
  /** Deletes everything kept for a granted folder: called when its grant is removed. */
  forgetGrant(root: string): Promise<void>
}

const MiB = 1024 * 1024
export const CACHE_LIMITS = {
  maxEntryBytes: 8 * MiB,
  maxTotalBytes: 256 * MiB,
  maxEntries: 5000,
  /** Segments and characters accepted when an entry is read back. */
  maxSegments: 200_000,
  maxChars: 4_000_000,
  maxAtLength: 300,
} as const

const GRANT_DIR = /^[0-9a-f]{32}$/
const ENTRY_FILE = /^[0-9a-f]{64}\.json$/
const DECIMAL = /^(0|[1-9][0-9]{0,39})$/
const KIND = /^[a-z][a-z0-9-]{0,15}$/
const FAILURE = /^[a-z][a-z-]{0,31}$/
// Not defined on Windows; there lstat and the handle's identity do the work.
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The folder name of a granted folder's entries: a hash, so it can never name a path. */
export function grantId(root: string, platform: NodeJS.Platform = process.platform): string {
  return sha256(`grant\0${foldCase(pathApi(platform).normalize(root), platform)}`).slice(0, 32)
}

/** An entry's file name: a hash of the grant and the file's identity, size and times. */
export function entryName(key: DocumentFileKey, platform: NodeJS.Platform = process.platform) {
  const parts = [CACHE_FORMAT, grantId(key.root, platform), key.dev, key.ino, key.size]
  return `${sha256([...parts, key.mtimeNs, key.ctimeNs].map(String).join('\0'))}.json`
}

interface Indexed {
  grant: string
  bytes: number
  used: number
}

/**
 * The cache of extracted document text. Entries are JSON files named by a hash of their
 * key under `<dir>/<grant id>/`, written to a temporary file and renamed into place, with
 * owner-only permissions where the OS has them (Windows: userData's own ACL). An index of
 * names, sizes and last use is kept in memory and rebuilt from the folder on start.
 */
export class DocumentTextCache implements DocumentTextCacheLike {
  private readonly dir: string
  private readonly platform: NodeJS.Platform
  private readonly limits: { maxEntryBytes: number; maxTotalBytes: number; maxEntries: number }
  private readonly clock: () => number
  private readonly index = new Map<string, Indexed>()
  private total = 0
  private loading: Promise<void> | null = null

  constructor(private readonly options: DocumentTextCacheOptions) {
    this.dir = path.resolve(options.dir)
    this.platform = options.platform ?? process.platform
    this.limits = {
      maxEntryBytes: options.maxEntryBytes ?? CACHE_LIMITS.maxEntryBytes,
      maxTotalBytes: options.maxTotalBytes ?? CACHE_LIMITS.maxTotalBytes,
      maxEntries: options.maxEntries ?? CACHE_LIMITS.maxEntries,
    }
    this.clock = options.clock ?? Date.now
  }

  /** Bytes and entries held now (tests, diagnostics). */
  usage(): { bytes: number; entries: number } {
    return { bytes: this.total, entries: this.index.size }
  }

  /**
   * Builds the index from the folder, deleting what does not belong there: folders of
   * grants that no longer exist (removed while the app was closed), leftover temporary
   * files and anything that is not an entry. Then evicts down to the limits.
   */
  load(): Promise<void> {
    this.loading ??= this.scan().catch((error: unknown) => {
      console.error('document text cache: could not load', error)
    })
    return this.loading
  }

  has(key: DocumentFileKey): boolean {
    return this.index.has(this.fileOf(key))
  }

  async get(key: DocumentFileKey): Promise<CachedText | null> {
    await this.load()
    const file = this.fileOf(key)
    const held = this.index.get(file)
    if (!held) return null
    let raw: Buffer
    try {
      raw = await this.readEntry(file)
    } catch {
      await this.drop(file)
      return null
    }
    const value = parseEntry(raw, grantId(key.root, this.platform), key)
    if (!value) {
      await this.drop(file)
      return null
    }
    held.used = this.clock()
    const when = new Date(held.used)
    await fs.utimes(file, when, when).catch(() => undefined)
    return value
  }

  async put(key: DocumentFileKey, value: CachedText): Promise<boolean> {
    await this.load()
    if (!this.granted(key.root)) return false
    const grant = grantId(key.root, this.platform)
    const data = Buffer.from(
      JSON.stringify({
        format: CACHE_FORMAT,
        grant,
        file: {
          dev: String(key.dev),
          ino: String(key.ino),
          size: String(key.size),
          mtimeNs: String(key.mtimeNs),
          ctimeNs: String(key.ctimeNs),
        },
        ...value,
      }),
      'utf8',
    )
    if (data.length > this.limits.maxEntryBytes) return false
    const folder = path.join(this.dir, grant)
    const file = this.fileOf(key)
    try {
      await this.ensureFolder(this.dir)
      await this.ensureFolder(folder)
      const temp = path.join(folder, `${randomBytes(8).toString('hex')}.tmp`)
      await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 })
      await fs.rename(temp, file).catch(async (error: unknown) => {
        await fs.rm(temp, { force: true })
        throw error
      })
    } catch (error) {
      console.error('document text cache: could not write an entry', error)
      return false
    }
    const before = this.index.get(file)
    if (before) this.total -= before.bytes
    this.index.set(file, { grant, bytes: data.length, used: this.clock() })
    this.total += data.length
    // The grant may have been removed while this was written: its folder goes again.
    if (!this.granted(key.root)) {
      await this.forgetGrant(key.root)
      return false
    }
    await this.evict(file)
    return this.index.has(file)
  }

  async forgetGrant(root: string): Promise<void> {
    await this.load()
    const grant = grantId(root, this.platform)
    for (const [file, held] of this.index) {
      if (held.grant === grant) {
        this.index.delete(file)
        this.total -= held.bytes
      }
    }
    await fs.rm(path.join(this.dir, grant), { recursive: true, force: true })
  }

  private granted(root: string): boolean {
    const id = grantId(root, this.platform)
    return this.options.roots().some((r) => grantId(r, this.platform) === id)
  }

  private fileOf(key: DocumentFileKey): string {
    return path.join(this.dir, grantId(key.root, this.platform), entryName(key, this.platform))
  }

  /** Creates a cache folder owner-only, and refuses one that is a link or not a folder. */
  private async ensureFolder(folder: string): Promise<void> {
    await fs.mkdir(folder, { recursive: true, mode: 0o700 })
    const stats = await fs.lstat(folder)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${folder} is not a folder`)
    }
    if (this.platform !== 'win32' && (stats.mode & 0o077) !== 0) await fs.chmod(folder, 0o700)
  }

  /** An entry's bytes: a regular file (never a link), within the entry limit. */
  private async readEntry(file: string): Promise<Buffer> {
    const before = await fs.lstat(file, { bigint: true })
    if (!before.isFile() || before.size > BigInt(this.limits.maxEntryBytes)) {
      throw new Error('not an entry')
    }
    const handle = await fs.open(file, constants.O_RDONLY | O_NOFOLLOW)
    try {
      const stats = await handle.stat({ bigint: true })
      if (!stats.isFile() || stats.ino !== before.ino || stats.dev !== before.dev) {
        throw new Error('changed')
      }
      const size = Number(stats.size)
      if (size > this.limits.maxEntryBytes) throw new Error('too large')
      const buffer = Buffer.alloc(size)
      let read = 0
      while (read < size) {
        const { bytesRead } = await handle.read(buffer, read, size - read, read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      return buffer.subarray(0, read)
    } finally {
      await handle.close()
    }
  }

  private async drop(file: string): Promise<void> {
    const held = this.index.get(file)
    if (held) {
      this.index.delete(file)
      this.total -= held.bytes
    }
    await fs.rm(file, { force: true }).catch(() => undefined)
  }

  /** Removes the least recently used entries (never `keep` unless it alone is too much). */
  private async evict(keep: string): Promise<void> {
    const over = () =>
      this.total > this.limits.maxTotalBytes || this.index.size > this.limits.maxEntries
    if (!over()) return
    const oldest = [...this.index.entries()]
      .filter(([file]) => file !== keep)
      .sort((a, b) => a[1].used - b[1].used)
    for (const [file] of oldest) {
      if (!over()) break
      await this.drop(file)
    }
    if (over()) await this.drop(keep)
  }

  private async scan(): Promise<void> {
    let names: string[]
    try {
      const stats = await fs.lstat(this.dir)
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        await fs.rm(this.dir, { force: true })
        return
      }
      names = await fs.readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const grants = new Set(this.options.roots().map((root) => grantId(root, this.platform)))
    for (const name of names) {
      const folder = path.join(this.dir, name)
      const stats = await fs.lstat(folder).catch(() => null)
      if (!stats) continue
      // rm never follows a link: a planted one is removed, not what it points to.
      if (!GRANT_DIR.test(name) || !grants.has(name) || !stats.isDirectory()) {
        await fs.rm(folder, { recursive: true, force: true })
        continue
      }
      for (const entry of await fs.readdir(folder)) {
        const file = path.join(folder, entry)
        const info = await fs.lstat(file).catch(() => null)
        if (!info) continue
        if (!ENTRY_FILE.test(entry) || !info.isFile() || info.size > this.limits.maxEntryBytes) {
          await fs.rm(file, { recursive: true, force: true })
          continue
        }
        this.index.set(file, { grant: name, bytes: info.size, used: info.mtimeMs })
        this.total += info.size
      }
    }
    await this.evict('')
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))

/**
 * An entry read back, or null for anything but exactly what put() writes for this key:
 * the format, grant and file identity must match, and every field is shape- and size-checked.
 */
export function parseEntry(raw: Buffer, grant: string, key: DocumentFileKey): CachedText | null {
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const keys = [
    'format',
    'grant',
    'file',
    'kind',
    'segments',
    'scanned',
    'blankPages',
    'truncated',
    'failure',
  ]
  if (!hasOnly(value, keys)) return null
  if (value['format'] !== CACHE_FORMAT || value['grant'] !== grant) return null
  const file = value['file']
  if (!isRecord(file) || !hasOnly(file, ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'])) return null
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
    const stored = file[field]
    if (typeof stored !== 'string' || !DECIMAL.test(stored) || stored !== String(key[field])) {
      return null
    }
  }
  const { kind, segments, scanned, blankPages, truncated, failure } = value
  if (typeof kind !== 'string' || !KIND.test(kind)) return null
  if (typeof scanned !== 'boolean') return null
  if (typeof blankPages !== 'number' || !Number.isSafeInteger(blankPages) || blankPages < 0) {
    return null
  }
  if (truncated !== null && (typeof truncated !== 'string' || truncated.length > 200)) return null
  if (failure !== null && (typeof failure !== 'string' || !FAILURE.test(failure))) return null
  if (!Array.isArray(segments) || segments.length > CACHE_LIMITS.maxSegments) return null
  let chars = 0
  const checked: TextSegment[] = []
  for (const segment of segments as unknown[]) {
    if (!isRecord(segment) || !hasOnly(segment, ['at', 'text', 'cells', 'offset'])) return null
    const { at, text, cells, offset } = segment
    if (typeof at !== 'string' || at.length > CACHE_LIMITS.maxAtLength) return null
    if (typeof text !== 'string') return null
    if (cells !== undefined && cells !== true) return null
    if (
      offset !== undefined &&
      (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 1)
    ) {
      return null
    }
    chars += text.length
    if (chars > CACHE_LIMITS.maxChars) return null
    checked.push({
      at,
      text,
      ...(cells ? { cells: true } : {}),
      ...(offset !== undefined ? { offset } : {}),
    })
  }
  return {
    kind,
    segments: checked,
    scanned,
    blankPages,
    truncated,
    failure,
  }
}
