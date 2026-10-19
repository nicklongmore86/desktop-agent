// Checks a path the user dropped or picked before anything is read from it. The
// file may be anywhere (attaching does not need a grant), so this does the guard's
// location checks itself: path syntax (UNC, device and stream paths), the
// blocklist and the app's own data, secret names, links and hard links, on both
// the path as given and its real path. Reading goes through a handle proven to be
// the file that was checked.
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { ATTACHMENT_MAX_PATH, type AttachErrorCode } from '../../shared/ipc-attachments'
import { hasUnsafeReferenceChars, SECRET_REFERENCE } from '../files/actions'
import { isSecretName } from '../files/secret-names'
import { blocklistReason } from '../permissions/blocklist'
import type { PathGuard } from '../permissions/guard'
import { checkPathSyntax, samePath } from '../permissions/paths'
import { readBounded, sameIdentity, type Identity } from '../tools/safe-fs'

export type Refusal = { ok: false; code: AttachErrorCode; reason: string }

export type CheckedSource =
  | {
      ok: true
      type: 'folder' | 'file'
      /** The real path: links along the way resolved, long (not 8.3) names. */
      path: string
      /** The granted folder it is in, or null when it is outside every grant. */
      root: string | null
      identity: Identity
      size: number
    }
  | Refusal

export const refuse = (code: AttachErrorCode, reason: string): Refusal => ({
  ok: false,
  code,
  reason,
})

// Not defined on Windows; there the handle identity check does the work.
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

const errnoCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code

const LINK_REASON =
  'Links and shortcuts are not followed. Attach the file or folder they point to instead.'
const HARD_LINK_REASON =
  'This file has other hard links (the same file under another name), so it is not attached. Attach a copy instead.'

/** Location checks that need no file system: shape, characters, blocklist, secret names. */
function checkLocation(guard: PathGuard, p: string): Refusal | null {
  const syntax = checkPathSyntax(p, guard.platform)
  if (syntax) return refuse(/network/i.test(syntax) ? 'blocked' : 'invalid', syntax)
  if (hasUnsafeReferenceChars(p))
    return refuse('invalid', 'This path contains a quote mark or control characters.')
  // Secrets and the built-in blocklist (keys, credentials) get the panels' secret wording;
  // the app's own data says what it is.
  if (isSecretName(guard.path.basename(p))) return refuse('secret', SECRET_REFERENCE)
  if (blocklistReason(p, guard.platform)) return refuse('blocked', SECRET_REFERENCE)
  const blocked = guard.blockedReason(p)
  if (blocked) return refuse('blocked', blocked)
  return null
}

/**
 * Validates a dropped or picked path. Refuses an empty path (a drag that has no file
 * on disk, such as an item inside a zip folder), over-long paths, network and device
 * paths, quote/control/bidi characters, blocked locations and the app's own data,
 * secret names, a final link or junction (never followed; links further up are
 * resolved and the real path is checked again), hard links, and anything that is
 * not a plain file or folder (devices, pipes, sockets).
 */
export async function checkSource(guard: PathGuard, raw: string): Promise<CheckedSource> {
  if (raw === '')
    return refuse(
      'invalid',
      'This item is not a file on disk (for example, a file inside a zip folder). Extract it first.',
    )
  if (raw.length > ATTACHMENT_MAX_PATH) return refuse('invalid', 'This path is too long.')
  const P = guard.path
  // Checked as given first: a blocked or secret file is never even opened for stat.
  const early = checkLocation(guard, raw)
  if (early) return early
  const given = P.resolve(raw)
  const lexical = checkLocation(guard, given)
  if (lexical) return lexical

  let entry: BigIntStats
  try {
    entry = await fs.lstat(given, { bigint: true })
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return refuse('not-found', 'That file or folder no longer exists.')
    return refuse('failed', 'That file or folder cannot be read.')
  }
  if (entry.isSymbolicLink()) return refuse('link', LINK_REASON)

  let real: string
  try {
    real = await fs.realpath(given)
  } catch {
    return refuse('failed', 'That file or folder cannot be read.')
  }
  if (!samePath(real, given, guard.platform)) {
    // A link (or 8.3 alias) further up: check where it really is.
    const resolved = checkLocation(guard, real)
    if (resolved) return resolved
    try {
      entry = await fs.lstat(real, { bigint: true })
    } catch {
      return refuse('failed', 'That file or folder cannot be read.')
    }
    if (entry.isSymbolicLink()) return refuse('link', LINK_REASON)
  }

  const isFolder = entry.isDirectory()
  if (!isFolder && !entry.isFile())
    return refuse('invalid', 'Only plain files and folders can be attached.')
  if (!isFolder && entry.nlink > 1n) return refuse('link', HARD_LINK_REASON)

  const inGrant = await guard.resolve(real)
  const root = inGrant.ok && samePath(inGrant.path, real, guard.platform) ? inGrant.root : null
  return {
    ok: true,
    type: isFolder ? 'folder' : 'file',
    path: real,
    root,
    identity: { dev: entry.dev, ino: entry.ino },
    size: Number(entry.size),
  }
}

/**
 * Opens a checked file without following links and proves the handle is that file:
 * same device and inode, still a plain file with a single link. The caller closes it.
 */
export async function openChecked(path: string, identity: Identity): Promise<FileHandle | Refusal> {
  let handle: FileHandle
  try {
    handle = await fs.open(path, constants.O_RDONLY | O_NOFOLLOW)
  } catch (error) {
    if (errnoCode(error) === 'ELOOP') return refuse('link', LINK_REASON)
    if (errnoCode(error) === 'ENOENT') return refuse('not-found', 'That file no longer exists.')
    return refuse('failed', 'That file cannot be read.')
  }
  let refusal: Refusal | null
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || !sameIdentity(stats, identity))
      refusal = refuse('failed', 'That file changed while it was being checked. Try again.')
    else if (stats.nlink > 1n) refusal = refuse('link', HARD_LINK_REASON)
    else refusal = null
  } catch {
    refusal = refuse('failed', 'That file cannot be read.')
  }
  if (refusal) {
    await handle.close()
    return refusal
  }
  return handle
}

/** Reads at most `max` bytes from the start; `whole` is false when the file is longer. */
export async function readUpTo(
  handle: FileHandle,
  max: number,
): Promise<{ bytes: Buffer; whole: boolean }> {
  const bytes = await readBounded(handle, max + 1)
  return bytes.length > max
    ? { bytes: bytes.subarray(0, max), whole: false }
    : { bytes, whole: true }
}
