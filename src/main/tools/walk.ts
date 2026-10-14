import { promises as fs } from 'node:fs'
import type { PathGuard } from '../permissions/guard'
import { ToolFailure } from './define'

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
}

export interface WalkOptions {
  /** Deepest level to yield (1 = direct children only). */
  maxDepth: number
  signal: AbortSignal
  /** Folder names never descended into (still yielded). */
  skipDirs?: ReadonlySet<string>
  /** Called for every entry hidden by the blocklist (not yielded, never descended). */
  onBlocked?: (path: string) => void
  /** Called for folders that could not be read. */
  onUnreadable?: (path: string) => void
}

function kindOf(stats: {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): EntryKind {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  return 'other'
}

/**
 * Depth-first walk of a resolved folder, in name order. Never follows
 * symlinks or junctions, so every yielded path is a real path below `start`,
 * and skips anything on the blocklist. Stops early when the signal aborts.
 */
export async function* walk(
  start: string,
  guard: PathGuard,
  options: WalkOptions,
): AsyncGenerator<WalkEntry> {
  const P = guard.path
  async function* visit(dir: string, relDir: string, depth: number): AsyncGenerator<WalkEntry> {
    let names: string[]
    try {
      names = (await fs.readdir(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    } catch {
      options.onUnreadable?.(dir)
      return
    }
    for (const name of names) {
      if (options.signal.aborted) return
      const path = P.join(dir, name)
      if (guard.blockedReason(path)) {
        options.onBlocked?.(path)
        continue
      }
      let stats: Awaited<ReturnType<typeof fs.lstat>>
      try {
        stats = await fs.lstat(path)
      } catch {
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
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      }
      if (kind === 'dir' && depth < options.maxDepth && !options.skipDirs?.has(name)) {
        yield* visit(path, rel, depth + 1)
      }
    }
  }
  yield* visit(start, '', 1)
}

/**
 * Checks a folder for blocklisted entries before it is moved or deleted: a
 * move or delete must never carry protected files along. Throws ToolFailure
 * when one is found, when the folder has more than `limit` entries (too big
 * to check), or when the walk is cancelled.
 */
export async function assertNoBlockedInside(
  dir: string,
  guard: PathGuard,
  limit: number,
  signal: AbortSignal,
): Promise<void> {
  const found: string[] = []
  let count = 0
  for await (const _entry of walk(dir, guard, {
    maxDepth: Number.POSITIVE_INFINITY,
    signal,
    onBlocked: (p) => found.push(p),
  })) {
    if (found.length > 0) break
    if (++count > limit) {
      throw new ToolFailure(`${dir} has too many entries to check for protected files.`)
    }
  }
  // An aborted walk proves nothing.
  if (signal.aborted) throw new ToolFailure('Cancelled.')
  if (found.length > 0) throw new ToolFailure(`${dir} contains a protected item: ${found[0] ?? ''}`)
}
