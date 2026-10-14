import { promises as fs, type BigIntStats } from 'node:fs'
import type { PathGuard } from '../permissions/guard'
import { samePath } from '../permissions/paths'
import { ToolFailure } from './define'
import { assertSingleLinkHandle, sameIdentity, type Identity } from './safe-fs'

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other'

export interface WalkEntry {
  path: string
  /** Relative to the walk's start, always `/`-separated. */
  rel: string
  name: string
  /** 1 for direct children of the start folder. */
  depth: number
  kind: EntryKind
  size: number
  mtimeMs: number
  nlink: number
  /** Device and inode at listing time; reads check the opened file against it. */
  id: Identity
}

export interface WalkOptions {
  /** Deepest level to yield (1 = direct children only). */
  maxDepth: number
  signal: AbortSignal
  /** Folder names never descended into (still yielded). */
  skipDirs?: ReadonlySet<string>
  /** Called for every entry hidden by the blocklist (not yielded, never descended). */
  onBlocked?: (path: string) => void
  /**
   * Called for every folder that could not be listed or re-verified and every
   * entry that could not be stat'ed. The walk skips them and carries on;
   * callers that need a complete picture must treat any call as a failure.
   */
  onError?: (path: string, reason: string) => void
}

function kindOf(stats: BigIntStats): EntryKind {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  return 'other'
}

function reasonOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'unknown error'
}

/**
 * Checks a folder immediately before listing it: still allowed by the guard
 * (so a revoked grant stops the walk) and resolving to itself, still a real
 * folder (not a link), and still the same inode as when its parent listed it.
 */
async function reverify(
  dir: string,
  guard: PathGuard,
  expected?: Identity,
): Promise<string | null> {
  try {
    const stats = await fs.lstat(dir, { bigint: true })
    if (stats.isSymbolicLink() || !stats.isDirectory()) return 'no longer a folder'
    if (expected && !sameIdentity(stats, expected)) return 'replaced while listing'
    const guarded = await guard.resolve(dir)
    if (!guarded.ok) return `no longer allowed: ${guarded.reason}`
    if (!samePath(guarded.path, dir, guard.platform)) return 'moved behind a link'
    return null
  } catch (error) {
    return reasonOf(error)
  }
}

/**
 * Depth-first walk of a resolved folder, in name order. Never follows
 * symlinks or junctions, re-verifies each folder just before listing it, and
 * skips anything on the blocklist, so every yielded path is a real path
 * below `start`. Stops early when the signal aborts.
 */
export async function* walk(
  start: string,
  guard: PathGuard,
  options: WalkOptions,
): AsyncGenerator<WalkEntry> {
  const P = guard.path
  async function* visit(
    dir: string,
    relDir: string,
    depth: number,
    expected?: Identity,
  ): AsyncGenerator<WalkEntry> {
    const problem = await reverify(dir, guard, expected)
    if (problem) {
      options.onError?.(dir, problem)
      return
    }
    let names: string[]
    try {
      names = (await fs.readdir(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    } catch (error) {
      options.onError?.(dir, reasonOf(error))
      return
    }
    for (const name of names) {
      if (options.signal.aborted) return
      const path = P.join(dir, name)
      if (!guard.isWithinGrants(path)) {
        options.onError?.(path, 'no longer inside a granted folder')
        return
      }
      if (guard.blockedReason(path)) {
        options.onBlocked?.(path)
        continue
      }
      let stats: BigIntStats
      try {
        stats = await fs.lstat(path, { bigint: true })
      } catch (error) {
        options.onError?.(path, reasonOf(error))
        continue
      }
      const rel = relDir === '' ? name : `${relDir}/${name}`
      const kind = kindOf(stats)
      yield {
        path,
        rel,
        name,
        depth,
        kind,
        size: Number(stats.size),
        mtimeMs: Number(stats.mtimeMs),
        nlink: Number(stats.nlink),
        id: { dev: stats.dev, ino: stats.ino },
      }
      if (kind === 'dir' && depth < options.maxDepth && !options.skipDirs?.has(name)) {
        yield* visit(path, rel, depth + 1, stats)
      }
    }
  }
  yield* visit(start, '', 1)
}

/**
 * Checks a folder for blocklisted entries before it is moved or deleted: a
 * move or delete must never carry protected files along. Fails closed:
 * throws ToolFailure when a protected entry is found, when anything inside
 * cannot be listed or stat'ed, when the folder has more than `limit` entries
 * (too big to check), or when the walk is cancelled.
 */
export async function assertNoBlockedInside(
  dir: string,
  guard: PathGuard,
  limit: number,
  signal: AbortSignal,
): Promise<void> {
  const blocked: string[] = []
  const errors: string[] = []
  let count = 0
  const hardLinked: string[] = []
  for await (const entry of walk(dir, guard, {
    maxDepth: Number.POSITIVE_INFINITY,
    signal,
    onBlocked: (p) => blocked.push(p),
    onError: (p, reason) => errors.push(`${p} (${reason})`),
  })) {
    if (blocked.length > 0 || errors.length > 0) break
    // Moving a hard link (especially copying it across volumes) or trashing it would
    // turn a second name of some file outside the grants into a plain, readable file.
    if (entry.kind === 'file') {
      try {
        await assertSingleLinkHandle(entry.path, entry.id)
      } catch (error) {
        if (error instanceof ToolFailure && error.code === 'hard-link') hardLinked.push(entry.path)
        else
          errors.push(`${entry.path} (${error instanceof Error ? error.message : String(error)})`)
        break
      }
    }
    if (++count > limit) {
      throw new ToolFailure(
        `${dir} has too many entries to check for protected files.`,
        'too-large',
      )
    }
  }
  // An aborted walk proves nothing.
  if (signal.aborted) throw new ToolFailure('Cancelled.', 'cancelled')
  if (blocked.length > 0) {
    throw new ToolFailure(`${dir} contains a protected item: ${blocked[0] ?? ''}`, 'protected')
  }
  if (hardLinked.length > 0) {
    throw new ToolFailure(
      `${dir} contains a file with other hard links (${hardLinked[0] ?? ''}); refusing.`,
      'hard-link',
    )
  }
  if (errors.length > 0) {
    throw new ToolFailure(
      `Could not check everything inside ${dir} for protected files: ${errors[0] ?? ''}. Nothing was done.`,
      'protected',
    )
  }
}
