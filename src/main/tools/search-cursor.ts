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
 * scanned pages, from there on.
 */
export interface CursorPosition {
  key: string
  inclusive: boolean
  ocrOnly?: boolean
}

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
  const { k, i, o } = value as Record<string, unknown>
  if (typeof k !== 'string' || typeof i !== 'boolean') return null
  if (o !== undefined && o !== true) return null
  return { key: k, inclusive: i, ...(o ? { ocrOnly: true } : {}) }
}

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

  /** Drops the kept items a call continuing from `position` would look at; returns how many. */
  cutAt(position: CursorPosition): number {
    const at = this.items.findIndex((item) => afterCursor(item.key, position))
    if (at < 0) return 0
    return this.items.splice(at).length
  }
}

/** Whether position `a` comes before `b` (starting at a key comes before starting after it). */
export function positionBefore(a: CursorPosition, b: CursorPosition): boolean {
  return a.key < b.key || (a.key === b.key && a.inclusive && !b.inclusive)
}
