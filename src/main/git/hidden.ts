// Which changed files the Git panel lists by name and status only. The rules are the
// Files tree's: secrets files (secret-names.ts), the agent's blocklist, links, files
// with other hard links, and names that cannot be shown or used safely. A hidden
// file's contents never leave main, whatever git would print for it.
import { promises as fs } from 'node:fs'
import { CONTROL_CHARS, parseRel } from '../files/location'
import { isSecretName } from '../files/secret-names'
import type { PathGuard } from '../permissions/guard'
import { checkPathSyntax, samePath } from '../permissions/paths'

export const SECRET_HIDDEN = 'A secrets file: its contents stay hidden here.'
const UNSAFE_NAME = 'This name cannot be shown safely.'

/**
 * The absolute path of a repository-relative path, or null when the name is not a
 * plain path (control characters, `..`, backslashes, a quote, ...). Quotes and
 * backslashes are refused too: git would quote such a name in a diff header.
 */
export function repoPath(guard: PathGuard, root: string, path: string): string | null {
  if (path.includes('"') || path.includes('\\') || CONTROL_CHARS.test(path)) return null
  const rel = parseRel(path.replace(/\/$/, ''), guard.platform)
  if (!rel.ok || rel.segments.length === 0) return null
  const absolute = guard.path.join(root, ...rel.segments)
  return checkPathSyntax(absolute, guard.platform) ? null : absolute
}

async function oneReason(guard: PathGuard, root: string, path: string): Promise<string | null> {
  const absolute = repoPath(guard, root, path)
  if (!absolute) return UNSAFE_NAME
  const name = guard.path.basename(absolute)
  if (isSecretName(name)) return SECRET_HIDDEN
  const blocked = guard.blockedReason(absolute)
  if (blocked) return blocked
  let stats: { isSymbolicLink(): boolean; isDirectory(): boolean; nlink: number } | null = null
  try {
    stats = await fs.lstat(absolute)
  } catch {
    // Deleted in the working tree: its parent is still checked below.
  }
  if (stats?.isSymbolicLink()) return 'A link: what it points to is not shown.'
  if (stats?.isDirectory()) return 'A folder.'
  if (stats && stats.nlink > 1)
    return 'This file has other hard links, so its contents are not shown (the agent cannot open it either).'
  const resolved = await guard.resolve(absolute)
  if (!resolved.ok) return resolved.reason
  if (resolved.exists && !samePath(resolved.path, absolute, guard.platform))
    return 'This file is reached through a link, so its contents are not shown.'
  if (!resolved.exists) {
    // A deleted file: the folder it was in must not be reached through a link either.
    const parent = guard.path.dirname(absolute)
    const where = await guard.resolve(parent)
    if (where.ok && where.exists && !samePath(where.path, parent, guard.platform))
      return 'This file is reached through a link, so its contents are not shown.'
  }
  return null
}

/** Why a changed file's contents are not shown (checking its old name too), or null. */
export async function hiddenReason(
  guard: PathGuard,
  root: string,
  path: string,
  oldPath?: string,
): Promise<string | null> {
  return (
    (await oneReason(guard, root, path)) ??
    (oldPath === undefined ? null : await oneReason(guard, root, oldPath))
  )
}
