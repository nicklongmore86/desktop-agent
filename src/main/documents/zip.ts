import { DEFAULT_LIMITS, type ZipLimits } from './limits'
import { DocumentError } from './types'

/**
 * A guarded ZIP reader for the OOXML and ODF formats a later change parses. It trusts
 * nothing the archive declares: entry counts and declared sizes are capped up front,
 * and inflation counts real output bytes as they stream, so an entry that lies about
 * its size, or a pile of small entries that add up, stops at the cap instead of
 * filling memory.
 */

export interface ZipEntry {
  name: string
  /** 0 = stored, 8 = deflated. */
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  encrypted: boolean
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MiB = 1024 * 1024

/**
 * The archive's entries from its central directory, checked against the limits: too
 * many entries, or declared sizes and ratios past them, throw DocumentError.
 */
export function readZipDirectory(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_LIMITS.zip,
): ZipEntry[] {
  const entries = listZipEntries(bytes, limits.maxEntries)
  let declaredTotal = 0
  for (const entry of entries) {
    checkDeclared(entry, limits)
    declaredTotal += entry.uncompressedSize
    if (declaredTotal > limits.maxTotalBytes) {
      throw new DocumentError('zip-bomb', 'The archive expands to more than is allowed.')
    }
  }
  return entries
}

/** The central directory as declared, without the size checks: enough to tell formats apart. */
export function listZipEntries(
  bytes: Uint8Array,
  maxEntries: number = DEFAULT_LIMITS.zip.maxEntries,
): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end record is the last 22 bytes plus a comment of up to 64 KiB.
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) {
      end = at
      break
    }
  }
  if (end < 0) throw new DocumentError('malformed', 'The archive has no central directory.')
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const offset = view.getUint32(end + 16, true)
  if (count === 0xffff || offset === 0xffffffff) {
    throw new DocumentError('unsupported', 'ZIP64 archives are not supported.')
  }
  if (count > maxEntries) {
    throw new DocumentError(
      'zip-bomb',
      `The archive has ${String(count)} entries; at most ${String(maxEntries)} are allowed.`,
    )
  }
  if (offset + size > end) throw new DocumentError('malformed', 'The archive is truncated.')

  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let at = offset
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) {
      throw new DocumentError('malformed', 'The archive directory is damaged.')
    }
    const flags = view.getUint16(at + 8, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    if (at + 46 + nameLength > end) {
      throw new DocumentError('malformed', 'The archive directory is damaged.')
    }
    const entry: ZipEntry = {
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localHeaderOffset: view.getUint32(at + 42, true),
      encrypted: (flags & 1) !== 0,
    }
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff) {
      throw new DocumentError('unsupported', 'ZIP64 archives are not supported.')
    }
    entries.push(entry)
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function checkDeclared(entry: ZipEntry, limits: ZipLimits): void {
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new DocumentError('zip-bomb', `"${entry.name}" expands to more than is allowed.`)
  }
  if (
    entry.uncompressedSize > MiB &&
    entry.uncompressedSize > entry.compressedSize * limits.maxRatio
  ) {
    throw new DocumentError('zip-bomb', `"${entry.name}" is compressed suspiciously well.`)
  }
}

/** Uncompressed bytes still allowed from one archive, shared by every entry read from it. */
export class ZipBudget {
  constructor(public remaining: number = DEFAULT_LIMITS.zip.maxTotalBytes) {}
}

/** The bytes the entry's local header points at, before decompression. */
function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = entry.localHeaderOffset
  if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL) {
    throw new DocumentError('malformed', `"${entry.name}" is damaged.`)
  }
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)
  if (start + entry.compressedSize > bytes.length) {
    throw new DocumentError('malformed', `"${entry.name}" is truncated.`)
  }
  return bytes.subarray(start, start + entry.compressedSize)
}

/**
 * One entry's contents. Inflation streams and stops as soon as the output passes the
 * entry's declared size, the per-entry cap, or what is left of the archive's budget.
 */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  budget: ZipBudget = new ZipBudget(),
  limits: ZipLimits = DEFAULT_LIMITS.zip,
): Promise<Uint8Array> {
  if (entry.encrypted) {
    throw new DocumentError('password-protected', 'The archive is password-protected.')
  }
  checkDeclared(entry, limits)
  const data = entryData(bytes, entry)
  const cap = Math.min(entry.uncompressedSize, limits.maxEntryBytes, budget.remaining)
  if (entry.method === 0) {
    if (data.length > cap)
      throw new DocumentError('zip-bomb', 'The archive is larger than allowed.')
    budget.remaining -= data.length
    return data
  }
  if (entry.method !== 8) {
    throw new DocumentError(
      'unsupported',
      `"${entry.name}" uses an unsupported compression method.`,
    )
  }

  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > cap) {
        throw new DocumentError('zip-bomb', `"${entry.name}" expands to more than it declares.`)
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof DocumentError) throw error
    throw new DocumentError('malformed', `"${entry.name}" is damaged.`)
  }
  budget.remaining -= total
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
