import type { DocumentLimits } from './limits'
import { DocumentError } from './types'

/**
 * Checks an OLE compound file's structure before SheetJS's CFB reader sees it, so a
 * hostile file cannot make that reader loop, do quadratic work, allocate what the file
 * does not hold, or read past its end. What SheetJS relies on is followed here first,
 * the way SheetJS follows it, and any sector is claimed by at most one structure or
 * stream (loops and overlaps are both refused; the work is linear in the file's size):
 *
 * - the header: signature, byte order, a 512-byte (version 3) or 4096-byte (version 4)
 *   sector, 64-byte mini sectors and the standard 4096-byte mini stream cutoff, and
 *   sector counts the file can hold;
 * - the FAT's sector list (header, then exactly the DIFAT sectors it needs) and the FAT;
 * - every chain in the FAT, as SheetJS walks them all up front: at most CHAIN_STEPS steps
 *   per sector in the file;
 * - the directory chain (at most MAX_ENTRIES entries), every entry's type, name length
 *   and links, which must form trees (no entry reached twice, no cycles);
 * - the mini FAT and mini stream chains, and every stream's chain in the FAT or mini FAT,
 *   which must be long enough for the stream's declared size.
 *
 * A stream declaring more bytes than the file holds is refused as 'zip-bomb'; anything
 * else wrong as 'malformed'.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const END_OF_CHAIN = 0xfffffffe
const FREE = 0xffffffff
/** SheetJS reads sector numbers as signed: from here up they end a chain. */
const NEGATIVE = 0x80000000
const NO_STREAM = 0xffffffff
const ENTRY_BYTES = 128
const MINI_SECTOR = 64
const MINI_CUTOFF = 4096
/** Header DIFAT entries; the rest of the FAT's sector list is in DIFAT sectors. */
const HEADER_DIFAT = 109
/**
 * Directory entries in one file; real documents have tens, rarely hundreds. SheetJS's
 * path builder is quadratic in the count.
 */
export const MAX_ENTRIES = 8192
/** Sectors SheetJS's up-front chain walk may visit, per sector in the file. */
const CHAIN_STEPS = 4

const UNUSED = 0
const STORAGE = 1
const STREAM = 2
const ROOT = 5

export function checkCfb(bytes: Uint8Array, limits: DocumentLimits): void {
  const bad = (why: string): DocumentError =>
    new DocumentError('malformed', `The legacy Office file is damaged (${why}).`)
  if (bytes.length > limits.maxDocumentBytes) {
    throw new DocumentError('too-large', 'The legacy Office file is larger than can be read here.')
  }
  if (bytes.length < 512 || SIGNATURE.some((byte, i) => bytes[i] !== byte)) {
    throw bad('its header is missing or cut short')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number): number => view.getUint16(at, true)
  const u32 = (at: number): number => view.getUint32(at, true)

  if (u16(0x1c) !== 0xfffe) throw bad('its byte order mark is wrong')
  const major = u16(0x1a)
  const shift = u16(0x1e)
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) {
    throw bad('its sectors are not 512 or 4096 bytes')
  }
  if (u16(0x20) !== 6 || u32(0x38) !== MINI_CUTOFF) throw bad('its mini sectors are not standard')
  const size = 1 << shift
  if (bytes.length < size * 2) throw bad('it is cut short')
  const perSector = size / 4
  // Sector n starts at (n + 1) * size; only the last may be cut short.
  const sectors = Math.ceil(bytes.length / size) - 1
  const offset = (n: number): number => (n + 1) * size
  const nFat = u32(0x2c)
  const firstDir = u32(0x30)
  const firstMiniFat = u32(0x3c)
  const nMiniFat = u32(0x40)
  const firstDifat = u32(0x44)
  const nDifat = u32(0x48)
  if (nFat === 0 || nFat > sectors || nMiniFat > sectors) {
    throw bad('its header counts more sectors than the file holds')
  }
  const needDifat = nFat > HEADER_DIFAT ? Math.ceil((nFat - HEADER_DIFAT) / (perSector - 1)) : 0
  if (nDifat !== needDifat) throw bad('its sector table list is not the size it says')

  // Each sector belongs to one structure or stream at most.
  const claimed = new Uint8Array(sectors)
  const claimWhole = (n: number, what: string): number => {
    if (n >= sectors || offset(n) + size > bytes.length) throw bad(`its ${what} is cut short`)
    if (claimed[n]) throw bad(`its ${what} loops or overlaps another part`)
    claimed[n] = 1
    return offset(n)
  }
  // SheetJS takes FAT sectors until one is negative (free), then whatever DIFAT holds up
  // to an end-of-chain: the lists must agree, so what follows the last is free or ends.
  const ends = (n: number): boolean => n === FREE || n === END_OF_CHAIN
  const fatSectors: number[] = []
  for (let i = 0; i < HEADER_DIFAT; i++) {
    const n = u32(0x4c + i * 4)
    if (i < nFat) fatSectors.push(n)
    else if (n < NEGATIVE) throw bad('its sector table list is longer than it says')
    else break
  }
  let next = firstDifat
  for (let i = 0; i < nDifat; i++) {
    if (next < sectors && claimed[next]) throw bad('its sector table list loops')
    const at = claimWhole(next, 'sector table list')
    for (let j = 0; j < perSector - 1; j++) {
      const n = u32(at + j * 4)
      if (fatSectors.length < nFat) fatSectors.push(n)
      else if (!ends(n)) throw bad('its sector table list is longer than it says')
    }
    next = u32(at + size - 4)
  }
  if (!ends(next)) throw bad('its sector table list is longer than it says')
  const fat = new Uint32Array(sectors).fill(FREE)
  fatSectors.forEach((sector, i) => {
    const at = claimWhole(sector, 'sector table')
    for (let j = 0; j < perSector && i * perSector + j < sectors; j++) {
      fat[i * perSector + j] = u32(at + j * 4)
    }
  })

  // SheetJS walks a chain from every sector not yet seen, starting at the directory's,
  // and re-walks a chain's tail each time it meets one from an earlier head.
  if (firstDir >= sectors) throw bad('its directory is cut short')
  const walked = new Uint8Array(sectors)
  const lastWalk = new Int32Array(sectors).fill(-1)
  let steps = 0
  for (let i = 0; i < sectors; i++) {
    const head = (i + firstDir) % sectors
    if (walked[head]) continue
    for (let n = head; ;) {
      if (++steps > CHAIN_STEPS * sectors + 1024) throw bad('its sector chains are tangled')
      walked[n] = 1
      lastWalk[n] = i
      const to = fat[n] ?? FREE
      if (to >= NEGATIVE || to >= sectors || lastWalk[to] === i) break
      n = to
    }
  }

  /** A chain of sectors through `table`, each claimed once; at most `max` long. */
  const follow = (
    start: number,
    table: Uint32Array,
    used: Uint8Array,
    max: number,
    what: string,
  ): number[] => {
    const chain: number[] = []
    for (let n = start; n !== END_OF_CHAIN; n = table[n] ?? FREE) {
      if (n >= used.length) throw bad(`its ${what} points past the end of the file`)
      if (used[n]) throw bad(`its ${what} loops or overlaps another part`)
      if (chain.length >= max) throw bad(`its ${what} is too long`)
      used[n] = 1
      chain.push(n)
    }
    return chain
  }
  const whole = (chain: number[], what: string): void => {
    for (const n of chain)
      if (offset(n) + size > bytes.length) throw bad(`its ${what} is cut short`)
  }

  const directory = follow(firstDir, fat, claimed, (MAX_ENTRIES * ENTRY_BYTES) / size, 'directory')
  whole(directory, 'directory')
  const count = (directory.length * size) / ENTRY_BYTES
  const entryAt = (i: number): number =>
    offset(directory[Math.floor((i * ENTRY_BYTES) / size)] ?? 0) + ((i * ENTRY_BYTES) % size)

  interface Entry {
    type: number
    start: number
    size: number
    links: number[]
  }
  const entries: Entry[] = []
  for (let i = 0; i < count; i++) {
    const at = entryAt(i)
    const type = bytes[at + 0x42] ?? 0
    const nameBytes = u16(at + 0x40)
    const links = [u32(at + 0x44), u32(at + 0x48), u32(at + 0x4c)]
    const low = u32(at + 0x78)
    // Version 3 files may leave junk in the high half; readers ignore it there.
    const length = major === 3 ? low : u32(at + 0x7c) * 2 ** 32 + low
    const entry = { type, start: u32(at + 0x74), size: length, links }
    entries.push(entry)
    // SheetJS follows every entry's links and reads every entry's data, used or not.
    if (links.some((link) => link !== NO_STREAM && link >= count)) {
      throw bad('a directory entry points past the directory')
    }
    if (type === UNUSED && length === 0) continue
    if (type !== UNUSED && type !== STORAGE && type !== STREAM && type !== ROOT) {
      throw bad('a directory entry has an unknown type')
    }
    if ((type === ROOT) !== (i === 0)) throw bad('its root entry is missing or repeated')
    if (nameBytes > 64 || nameBytes % 2 !== 0) throw bad('a directory entry name is too long')
    if (length > bytes.length) {
      throw new DocumentError(
        'zip-bomb',
        'The legacy Office file declares a stream larger than the file itself; it was not read.',
      )
    }
  }
  const root = entries[0]
  if (root?.type !== ROOT) throw bad('its root entry is missing or repeated')

  // The links must form trees: no entry linked to twice or from itself, the root not at
  // all, and every entry reached from one that nothing links to (else it is on a cycle).
  const linkedTo = new Uint8Array(count)
  for (const entry of entries) {
    for (const link of entry.links) {
      if (link === NO_STREAM) continue
      if (linkedTo[link] || link === 0) throw bad('its directory loops')
      linkedTo[link] = 1
    }
  }
  const reached = new Uint8Array(count)
  for (let top = 0; top < count; top++) {
    if (linkedTo[top]) continue
    const stack = [top]
    while (stack.length > 0) {
      const i = stack.pop() ?? 0
      reached[i] = 1
      for (const link of entries[i]?.links ?? []) if (link !== NO_STREAM) stack.push(link)
    }
  }
  if (reached.includes(0)) throw bad('its directory loops')

  // The mini stream (the root's data) and the mini FAT that chains its 64-byte sectors.
  const miniSectors = Math.ceil(root.size / MINI_SECTOR)
  if (root.size > 0) {
    const chain = follow(root.start, fat, claimed, sectors, 'mini stream')
    if (chain.length * size < root.size) throw bad('its mini stream is shorter than declared')
  }
  const miniChain =
    nMiniFat === 0 || firstMiniFat === END_OF_CHAIN
      ? []
      : follow(firstMiniFat, fat, claimed, sectors, 'mini sector table')
  whole(miniChain, 'mini sector table')
  const miniFat = new Uint32Array(Math.min(miniChain.length * perSector, miniSectors)).fill(FREE)
  miniChain.forEach((sector, i) => {
    for (let j = 0; j < perSector && i * perSector + j < miniFat.length; j++) {
      miniFat[i * perSector + j] = u32(offset(sector) + j * 4)
    }
  })
  const miniClaimed = new Uint8Array(miniFat.length)

  for (const [i, entry] of entries.entries()) {
    if (i === 0 || entry.size === 0) continue
    if (entry.size >= MINI_CUTOFF) {
      // SheetJS reads these from the FAT whatever the entry's type.
      const need = Math.ceil(entry.size / size)
      const chain = follow(entry.start, fat, claimed, sectors, 'stream chain')
      if (chain.length < need) throw bad('a stream is shorter than its declared size')
      // Every sector a stream needs is in the file; only the last may be partly so.
      whole(chain.slice(0, need - 1), 'stream')
      const last = chain[need - 1] ?? 0
      if (offset(last) + (entry.size - (need - 1) * size) > bytes.length) {
        throw bad('a stream is cut short')
      }
    } else if (entry.type === STREAM) {
      const need = Math.ceil(entry.size / MINI_SECTOR)
      const chain = follow(entry.start, miniFat, miniClaimed, miniFat.length, 'mini stream chain')
      if (chain.length < need) throw bad('a stream is shorter than its declared size')
    }
  }
}
