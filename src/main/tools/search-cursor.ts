import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * search_files' continuation cursor: where in the stable order (files sorted by relative
 * path) a call stopped. It is opaque to the model: the position is encrypted with a key
 * new to each run of the app, and authenticated together with the call's root and every
 * search option, so a cursor only continues the very search that gave it. A cursor that
 * was changed, comes from another search or from an earlier run of the app is refused.
 */

const PREFIX = 'sf1.'
const IV_BYTES = 12
const TAG_BYTES = 16
/** The longest cursor a call may pass (a position is one relative path). */
export const MAX_CURSOR_LENGTH = 4096
const BASE64URL = /^[A-Za-z0-9_-]+$/u

/** Made once per process: cursors do not outlive the app. */
const KEY = randomBytes(32)

/**
 * Where the next call starts: after `key`, or at it when `inclusive`. `ocrOnly` says that
 * every other file was reported by earlier calls, so the next call reports only PDFs with
 * scanned pages, from there on. `reported` (only with `ocrOnly`) names a set in
 * `reportedSets`: the PDFs from `key` on that earlier calls already reported, out of path
 * order, which the next call passes over.
 */
export interface CursorPosition {
  key: string
  inclusive: boolean
  ocrOnly?: boolean
  reported?: string
}

const REPORTED_ID = /^[0-9a-f]{32}$/u

/**
 * The order key of a relative path ("a/b"): its segments joined by U+0000, so plain string
 * comparison orders files as the walk yields them (a folder's entries right after it, each
 * folder's names sorted by code unit), and as "sorted by relative path" means here.
 */
export const orderKey = (rel: string): string => rel.split('/').join('\u0000')

/** Whether `key` comes after the cursor, so a continuing call should look at it. */
export function afterCursor(key: string, cursor: CursorPosition | null): boolean {
  if (cursor === null) return true
  return cursor.inclusive ? key >= cursor.key : key > cursor.key
}

/** The digest a cursor is bound to: the call's root and options, in a fixed order. */
export function cursorBinding(parts: readonly (string | number | boolean | null)[]): Buffer {
  return createHash('sha256')
    .update(JSON.stringify(['search_files', ...parts]))
    .digest()
}

export function encodeCursor(position: CursorPosition, binding: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  cipher.setAAD(binding)
  const body = Buffer.concat([
    cipher.update(
      JSON.stringify({
        k: position.key,
        i: position.inclusive,
        ...(position.ocrOnly ? { o: true } : {}),
        ...(position.ocrOnly && position.reported !== undefined ? { r: position.reported } : {}),
      }),
      'utf8',
    ),
    cipher.final(),
  ])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

/** The position a cursor holds, or null when it is malformed, changed or for another search. */
export function decodeCursor(token: string, binding: Buffer): CursorPosition | null {
  if (token.length > MAX_CURSOR_LENGTH || !token.startsWith(PREFIX)) return null
  const encoded = token.slice(PREFIX.length)
  if (!BASE64URL.test(encoded)) return null
  const raw = Buffer.from(encoded, 'base64url')
  // Exactly what encodeCursor writes: no spare bits or characters that decode the same.
  if (raw.length <= IV_BYTES + TAG_BYTES || raw.toString('base64url') !== encoded) return null
  let plain: string
  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, IV_BYTES))
    decipher.setAAD(binding)
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(plain)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { k, i, o, r } = value as Record<string, unknown>
  if (typeof k !== 'string' || typeof i !== 'boolean') return null
  if (o !== undefined && o !== true) return null
  if (r !== undefined && (o !== true || typeof r !== 'string' || !REPORTED_ID.test(r))) return null
  return {
    key: k,
    inclusive: i,
    ...(o ? { ocrOnly: true } : {}),
    ...(typeof r === 'string' ? { reported: r } : {}),
  }
}

/** The most PDFs one cursor's reported set holds: well past what one call can visit. */
export const MAX_REPORTED_KEYS = 100_000
/** The most reported sets kept at once; the least recently used goes first. */
export const MAX_REPORTED_SETS = 32
/** The most keys kept across every set; the least recently used sets go first. */
export const MAX_REPORTED_TOTAL = 200_000
/** How long a set is kept after it was last made or used. */
export const REPORTED_TTL_MS = 2 * 60 * 60_000

/**
 * The PDFs with scanned pages a search reported out of path order, past its cursor's key, kept
 * in the main process under a random id the (encrypted, authenticated) cursor carries. Each
 * cursor gets its own set, never changed after, so a cursor used twice continues the same way.
 * Kept for a while and within bounds: a cursor whose set is gone is refused, never followed
 * without it (that would report its files again).
 */
export class ReportedSets {
  private readonly sets = new Map<string, { keys: ReadonlySet<string>; used: number }>()
  private total = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = {
      keys: MAX_REPORTED_KEYS,
      sets: MAX_REPORTED_SETS,
      total: MAX_REPORTED_TOTAL,
      ttlMs: REPORTED_TTL_MS,
    },
  ) {}

  /** Keeps a set; its id, or null when it is too big to keep. */
  put(keys: Iterable<string>): string | null {
    const set = new Set(keys)
    if (set.size > this.limits.keys || set.size > this.limits.total) return null
    this.expire()
    while (
      this.sets.size > 0 &&
      (this.sets.size >= this.limits.sets || this.total + set.size > this.limits.total)
    ) {
      const oldest = this.sets.keys().next().value as string
      this.remove(oldest)
    }
    const id = randomBytes(16).toString('hex')
    this.sets.set(id, { keys: set, used: this.now() })
    this.total += set.size
    return id
  }

  /** The set under `id`, or null when it is gone (expired, pushed out, or from another run). */
  get(id: string): ReadonlySet<string> | null {
    this.expire()
    const entry = this.sets.get(id)
    if (!entry) return null
    // Most recently used last, so the oldest is first in the map.
    this.sets.delete(id)
    entry.used = this.now()
    this.sets.set(id, entry)
    return entry.keys
  }

  get size(): number {
    return this.sets.size
  }

  private expire(): void {
    const cutoff = this.now() - this.limits.ttlMs
    for (const [id, entry] of this.sets) if (entry.used < cutoff) this.remove(id)
  }

  private remove(id: string): void {
    const entry = this.sets.get(id)
    if (!entry) return
    this.total -= entry.keys.size
    this.sets.delete(id)
  }
}

/** The process's reported sets: like the cursor key, they do not outlive the app. */
export const reportedSets = new ReportedSets()

/**
 * Items kept sorted by key, at most `max` of them: the first `max` in key order of all that
 * were added, whatever order they came in. Every addition is counted.
 */
export class SortedCapped<T extends { key: string }> {
  readonly items: T[] = []
  /** Everything added, kept or not. */
  total = 0
  /** Whether an item was ever dropped for want of room (all dropped keys follow every kept one). */
  overflowed = false

  constructor(readonly max: number) {}

  add(item: T): void {
    this.total++
    const items = this.items
    if (items.length >= this.max) {
      const last = items.at(-1)
      if (last && item.key >= last.key) {
        this.overflowed = true
        return
      }
    }
    let lo = 0
    let hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((items[mid] as T).key < item.key) lo = mid + 1
      else hi = mid
    }
    items.splice(lo, 0, item)
    if (items.length > this.max) {
      items.pop()
      this.overflowed = true
    }
  }

  /**
   * Drops the kept items a call continuing from `position` would look at, except those `keep`
   * says stay (the next call passes over them); returns how many were dropped.
   */
  cutAt(position: CursorPosition, keep?: (key: string) => boolean): number {
    const at = this.items.findIndex((item) => afterCursor(item.key, position))
    if (at < 0) return 0
    if (!keep) return this.items.splice(at).length
    const tail = this.items.splice(at)
    const kept = tail.filter((item) => keep(item.key))
    this.items.push(...kept)
    return tail.length - kept.length
  }
}

/** Whether position `a` comes before `b` (starting at a key comes before starting after it). */
export function positionBefore(a: CursorPosition, b: CursorPosition): boolean {
  return a.key < b.key || (a.key === b.key && a.inclusive && !b.inclusive)
}
