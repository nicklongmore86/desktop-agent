// Opening files the guard has approved, as safely as Node allows. There is no
// openat()/handle-relative API, so a local process racing us could still swap
// a path between check and use; these checks narrow that window and make most
// swaps fail instead of succeeding silently. See the README's threat model.
import { createHash } from 'node:crypto'
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { PathGuard } from '../permissions/guard'
import { samePath } from '../permissions/paths'
import { ToolFailure } from './define'

export interface Identity {
  dev: bigint
  ino: bigint
}

// Not defined on Windows; there the fstat identity check does the work.
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

const MODES = {
  read: constants.O_RDONLY | O_NOFOLLOW,
  update: constants.O_RDWR | O_NOFOLLOW,
  create: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
} as const

export type OpenMode = keyof typeof MODES

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** Refuses files with more than one name: a hard link can alias a file outside the grants. */
export function assertSingleLink(path: string, stats: { nlink: bigint | number }): void {
  if (BigInt(stats.nlink) > 1n) {
    throw new ToolFailure(
      `${path} has other hard links: the same file also has another name, possibly outside the ` +
        'granted folders, so it is refused (common in pnpm node_modules and C:\\Windows). To ' +
        'use it, the user can copy it into a granted folder: a copy is a separate file.',
      'hard-link',
    )
  }
}

/**
 * Opens a guarded file and proves the handle is what was checked: the entry
 * is a regular file (not a link) before opening, the opened handle has the
 * same device and inode (and `expected`, when given), it has exactly one
 * hard link, and the path still resolves through the guard to itself.
 * The caller must do all reads and writes through the returned handle and
 * close it.
 */
export async function openVerified(
  guard: PathGuard,
  path: string,
  mode: OpenMode,
  expected?: Identity,
): Promise<{ handle: FileHandle; stats: BigIntStats }> {
  let before: BigIntStats | null = null
  if (mode !== 'create') {
    before = await fs.lstat(path, { bigint: true })
    if (before.isSymbolicLink()) throw changed(path)
    if (!before.isFile()) throw new ToolFailure(`Not a regular file: ${path}`, 'not-a-file')
    if (expected && !sameIdentity(before, expected)) throw changed(path)
  }

  let handle: FileHandle
  try {
    handle = await fs.open(path, MODES[mode], 0o666)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ELOOP') throw changed(path)
    throw error
  }
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile()) throw changed(path)
    if (before && !sameIdentity(stats, before)) throw changed(path)
    assertSingleLink(path, stats)
    const again = await guard.resolve(path)
    if (!again.ok) throw new ToolFailure(`Access denied: ${again.reason}`, 'access-denied')
    if (!samePath(again.path, path, guard.platform)) throw changed(path)
    return { handle, stats }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * Opens a file found by a walk without following links, and checks through
 * the handle that it is the entry that was listed and has a single link.
 * Lighter than openVerified (no guard round trip): the walk has already
 * re-verified the folder it is in.
 */
export async function assertSingleLinkHandle(path: string, expected: Identity): Promise<void> {
  let handle: FileHandle
  try {
    handle = await fs.open(path, MODES.read)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw changed(path)
    throw error
  }
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || !sameIdentity(stats, expected)) throw changed(path)
    assertSingleLink(path, stats)
  } finally {
    await handle.close()
  }
}

function changed(path: string): ToolFailure {
  return new ToolFailure(`${path} changed while it was being checked; nothing was done.`, 'changed')
}

/** Reads up to `max` bytes from the start of a handle. */
export async function readBounded(handle: FileHandle, max: number): Promise<Buffer> {
  const buf = Buffer.alloc(max)
  let total = 0
  while (total < max) {
    const { bytesRead } = await handle.read(buf, total, max - total, total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  return buf.subarray(0, total)
}

/** SHA-256 of a handle's whole content, read in chunks. */
export async function hashHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(64 * 1024)
  let position = 0
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
    if (bytesRead === 0) break
    hash.update(chunk.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

/** Writes all of `data` at the start of the handle and cuts the file to its length. */
export async function overwriteHandle(handle: FileHandle, data: Buffer): Promise<void> {
  await handle.truncate(0)
  let written = 0
  while (written < data.length) {
    const { bytesWritten } = await handle.write(data, written, data.length - written, written)
    written += bytesWritten
  }
  await handle.sync()
}

/** Replaces the content of `to` with all of `from`, in chunks, and syncs it. Returns the bytes copied. */
export async function copyHandle(from: FileHandle, to: FileHandle): Promise<bigint> {
  await to.truncate(0)
  const chunk = Buffer.alloc(64 * 1024)
  let position = 0
  for (;;) {
    const { bytesRead } = await from.read(chunk, 0, chunk.length, position)
    if (bytesRead === 0) break
    let written = 0
    while (written < bytesRead) {
      const { bytesWritten } = await to.write(
        chunk,
        written,
        bytesRead - written,
        position + written,
      )
      written += bytesWritten
    }
    position += bytesRead
  }
  await to.sync()
  return BigInt(position)
}
