// Text extracted from documents for search_files, kept so a later search does not send
// the same files through the document reader again. It lives in the app's data folder
// (userData, which the agent's guard blocks), one folder per granted folder, and the
// folder goes when its grant does. What is read back is treated as untrusted: it is
// checked as strictly as a worker reply, and anything unexpected is deleted and missed.
import { createHash, randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { foldCase, pathApi } from '../permissions/paths'

/**
 * Bumped whenever what is stored, or how it is extracted, changes: older entries miss. 2:
 * per-page OCR state instead of `scanned` and `blankPages`, whose text pages may hide a scan
 * under a stamp. The format is in the entry's name, so a format 1 entry is never looked up;
 * it stays in the 256 MB total until it is the least recently used.
 */
export const CACHE_FORMAT = 2

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

/** A PDF page with no usable text layer (see ocrReason), and what OCR has made of it so far. */
export interface OcrPage {
  page: number
  /** 'no-text': next to no text layer. 'stamp': a little text over a page-sized image. */
  reason: 'no-text' | 'stamp'
  /** Long edge, in pixels, to render the page at for OCR. */
  longEdge: number
  /** 'pending': not recognised yet; 'done': `text` holds what was; 'failed': see `failure`. */
  state: 'pending' | 'done' | 'failed'
  text: string
  /** Done, but OCR found little readable text on a page that has ink: it may have missed some. */
  low: boolean
  /** Why OCR will not be tried again until the file changes (a short code). */
  failure: string | null
}

export interface CachedText {
  /** The reader's DocumentKind for the file (pdf, docx, xlsx, ...). */
  kind: string
  segments: TextSegment[]
  /** PDFs: the pages that need OCR, in page order. Their text layer, if any, stays in segments. */
  ocr: OcrPage[]
  /** Set when the text stops before the end (the per-document limits): what was read. */
  truncated: string | null
  /** A refusal that will not change until the file does (password-protected, malformed). */
  failure: string | null
}

/** The granted folders, and the token of each grant (GrantStore). */
export interface GrantTokens {
  list(): readonly string[]
  /** Null when `root` is not granted; a new token each time it is granted again. */
  token(root: string): string | null
}

export interface DocumentTextCacheOptions {
  dir: string
  /** An entry is only written for a grant whose token is still the one its text was read under. */
  grants: GrantTokens
  platform?: NodeJS.Platform
  /** Largest entry kept, serialized. Bigger texts are searched but not kept. */
  maxEntryBytes?: number
  /** All entries together; the least recently used go first. */
  maxTotalBytes?: number
  maxEntries?: number
  /** Entries, and their bytes, one eviction may read to find those holding OCR work. */
  maxEvictionProbes?: number
  maxEvictionProbeBytes?: number
  /** Wall clock in ms, for least-recently-used order. */
  clock?: () => number
}

export interface DocumentTextCacheLike {
  /** Builds the index from disk (once); `has` answers false until it has run. */
  load(): Promise<void>
  get(key: DocumentFileKey): Promise<CachedText | null>
  /** Whether an entry is held for `key`, without reading it (false until the index is loaded). */
  has(key: DocumentFileKey): boolean
  /** The token of `root`'s grant now (null: not granted): taken before reading a file, for put. */
  token(root: string): string | null
  /**
   * Keeps `value` if `key.root` is still granted under `token`; false when it was not kept.
   * A grant removed (and perhaps granted again) since `token` was taken keeps nothing.
   */
  put(key: DocumentFileKey, value: CachedText, token: string): Promise<boolean>
  /** Deletes everything kept for a granted folder: called when its grant is removed. */
  forgetGrant(root: string): Promise<void>
}

const MiB = 1024 * 1024
export const CACHE_LIMITS = {
  maxEntryBytes: 8 * MiB,
  maxTotalBytes: 256 * MiB,
  maxEntries: 5000,
  /**
   * What one eviction may read to tell entries found on start apart. A save usually needs one
   * or two entries gone; 32 entries and 32 MB let it look past a run of OCR entries at the old
   * end without reading the whole cache (256 MB) when started over the limits. Each entry is
   * read once: what it held is remembered.
   */
  maxEvictionProbes: 32,
  maxEvictionProbeBytes: 32 * MiB,
  /** Segments and characters accepted when an entry is read back. */
  maxSegments: 200_000,
  maxChars: 4_000_000,
  maxAtLength: 300,
  maxOcrPages: 200_000,
  maxOcrLongEdge: 4096,
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
  /**
   * Whether it holds OCR results (a page done or failed): slow to make again, so it is evicted
   * after every entry without. Null until known: entries found on start are looked at only
   * when something has to be evicted.
   */
  ocr: boolean | null
}

/** Whether a text holds OCR work: a page OCR read or gave up on. */
export const hasOcrWork = (value: CachedText): boolean =>
  value.ocr.some((page) => page.state !== 'pending')

// In what put() writes, a quote inside a string is always escaped, so these only match a field.
const OCR_WORK_MARKS = ['"state":"done"', '"state":"failed"'].map((mark) => Buffer.from(mark))

/**
 * The cache of extracted document text. Entries are JSON files named by a hash of their
 * key under `<dir>/<grant id>/`, written to a temporary file and renamed into place, with
 * owner-only permissions where the OS has them (Windows: userData's own ACL). An index of
 * names, sizes and last use is kept in memory and rebuilt from the folder on start.
 */
export class DocumentTextCache implements DocumentTextCacheLike {
  private readonly dir: string
  private readonly platform: NodeJS.Platform
  private readonly limits: {
    maxEntryBytes: number
    maxTotalBytes: number
    maxEntries: number
    maxEvictionProbes: number
    maxEvictionProbeBytes: number
  }
  /** Entries read to see whether they hold OCR work, in all (tests, diagnostics). */
  private probed = 0
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
      maxEvictionProbes: options.maxEvictionProbes ?? CACHE_LIMITS.maxEvictionProbes,
      maxEvictionProbeBytes: options.maxEvictionProbeBytes ?? CACHE_LIMITS.maxEvictionProbeBytes,
    }
    this.clock = options.clock ?? Date.now
  }

  /** Bytes and entries held now (tests, diagnostics). */
  usage(): { bytes: number; entries: number; probed: number } {
    return { bytes: this.total, entries: this.index.size, probed: this.probed }
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
    held.ocr = hasOcrWork(value)
    const when = new Date(held.used)
    await fs.utimes(file, when, when).catch(() => undefined)
    return value
  }

  token(root: string): string | null {
    return this.options.grants.token(root)
  }

  async put(key: DocumentFileKey, value: CachedText, token: string): Promise<boolean> {
    await this.load()
    if (this.token(key.root) !== token) return false
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
    // The grant may have been removed (and granted again) while this was written: the
    // entry goes, and the folder too while the folder is not granted.
    const now = this.token(key.root)
    if (now !== token) {
      if (now === null) await this.forgetGrant(key.root)
      else await this.drop(file)
      return false
    }
    const before = this.index.get(file)
    if (before) this.total -= before.bytes
    this.index.set(file, { grant, bytes: data.length, used: this.clock(), ocr: hasOcrWork(value) })
    this.total += data.length
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

  /**
   * Removes entries until within the limits: those without OCR results first, then those
   * with, least recently used first in each (never `keep` unless it alone is too much).
   */
  private async evict(keep: string): Promise<void> {
    const over = () =>
      this.total > this.limits.maxTotalBytes || this.index.size > this.limits.maxEntries
    if (!over()) return
    const oldest = [...this.index.entries()]
      .filter(([file]) => file !== keep)
      .sort((a, b) => a[1].used - b[1].used)
    // In LRU order, an entry not known to hold OCR work goes; one that does waits. Entries not
    // looked at yet (found on start) are looked at only as they come up, within a bound per
    // pass: past it, they go in plain LRU order, as before this distinction existed.
    let probes = 0
    let probedBytes = 0
    const withOcr: string[] = []
    for (const [file, held] of oldest) {
      if (!over()) return
      if (
        held.ocr === null &&
        probes < this.limits.maxEvictionProbes &&
        probedBytes + held.bytes <= this.limits.maxEvictionProbeBytes
      ) {
        probes++
        probedBytes += held.bytes
        this.probed++
        held.ocr = await this.holdsOcrWork(file)
      }
      if (held.ocr === true) withOcr.push(file)
      else await this.drop(file)
    }
    for (const file of withOcr) {
      if (!over()) return
      await this.drop(file)
    }
    if (over()) await this.drop(keep)
  }

  /** Whether an entry on disk holds OCR results, without parsing it (an unreadable one: no). */
  private async holdsOcrWork(file: string): Promise<boolean> {
    try {
      const raw = await this.readEntry(file)
      return OCR_WORK_MARKS.some((mark) => raw.includes(mark))
    } catch {
      return false
    }
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
    const grants = new Set(this.options.grants.list().map((root) => grantId(root, this.platform)))
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
        this.index.set(file, { grant: name, bytes: info.size, used: info.mtimeMs, ocr: null })
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
  const keys = ['format', 'grant', 'file', 'kind', 'segments', 'ocr', 'truncated', 'failure']
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
  const { kind, segments, ocr, truncated, failure } = value
  if (typeof kind !== 'string' || !KIND.test(kind)) return null
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
  if (!Array.isArray(ocr) || ocr.length > CACHE_LIMITS.maxOcrPages) return null
  const pages: OcrPage[] = []
  let last = 0
  for (const raw of ocr as unknown[]) {
    const page = parseOcrPage(raw, last)
    if (!page) return null
    chars += page.text.length
    if (chars > CACHE_LIMITS.maxChars) return null
    last = page.page
    pages.push(page)
  }
  return {
    kind,
    segments: checked,
    ocr: pages,
    truncated,
    failure,
  }
}

const OCR_PAGE_KEYS = ['page', 'reason', 'longEdge', 'state', 'text', 'low', 'failure'] as const

/** One page's OCR state read back: page numbers strictly ascend, and the state is consistent. */
function parseOcrPage(raw: unknown, after: number): OcrPage | null {
  if (!isRecord(raw) || !hasOnly(raw, OCR_PAGE_KEYS)) return null
  const { page, reason, longEdge, state, text, low, failure } = raw
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page <= after) return null
  if (reason !== 'no-text' && reason !== 'stamp') return null
  if (
    typeof longEdge !== 'number' ||
    !Number.isSafeInteger(longEdge) ||
    longEdge < 16 ||
    longEdge > CACHE_LIMITS.maxOcrLongEdge
  ) {
    return null
  }
  if (state !== 'pending' && state !== 'done' && state !== 'failed') return null
  if (typeof text !== 'string' || typeof low !== 'boolean') return null
  if (failure !== null && (typeof failure !== 'string' || !FAILURE.test(failure))) return null
  if ((state === 'failed') !== (failure !== null)) return null
  if (state !== 'done' && (text !== '' || low)) return null
  return { page, reason, longEdge, state, text, low, failure }
}
