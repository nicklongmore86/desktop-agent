// Turns what the renderer sends (a granted folder's id and a relative path) into
// a real path, through PathGuard. Shared by the file tree and, later, the Git
// panel: anything that lets the renderer point at a file inside the grants.
import { createHash } from 'node:crypto'
import type { FileLocation, FilesRoot } from '../../shared/ipc-files'
import { FILES_MAX_REL } from '../../shared/ipc-files'
import type { PathGuard } from '../permissions/guard'
import { checkPathSyntax, samePath } from '../permissions/paths'

/**
 * The opaque id of a granted folder: a hash of its stored real path. Stable for
 * as long as the grant exists, and says nothing about the path by itself.
 */
export function rootId(root: string): string {
  return `r${createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16)}`
}

export const ROOT_ID = /^r[0-9a-f]{16}$/

/** C0 and C1 control characters (NUL, CR, LF, tab, ESC, DEL, ...): never part of a usable name. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

/** The granted folders as the tree shows them. */
export function filesRoots(guard: PathGuard): FilesRoot[] {
  return guard.grantedRoots().map((root) => ({
    id: rootId(root),
    name: guard.path.basename(root) || root,
    path: root,
  }))
}

/** The granted folder an id names, or null when it is no longer granted. */
export function rootForId(guard: PathGuard, id: string): string | null {
  return guard.grantedRoots().find((root) => rootId(root) === id) ?? null
}

/**
 * The name segments of a relative path, or why it is refused. Only plain names
 * joined by `/`: no `.` or `..`, no empty segments, no backslashes, control
 * characters (NUL, CR, LF, ...) or (on Windows) colons, so it can never climb out of its folder or name a
 * device, an alternate data stream or an extended-length (`\\?\`) path.
 */
export function parseRel(
  rel: string,
  platform: NodeJS.Platform,
): { ok: true; segments: string[] } | { ok: false; reason: string } {
  if (rel.length > FILES_MAX_REL) return { ok: false, reason: 'That path is too long.' }
  if (rel === '') return { ok: true, segments: [] }
  const segments = rel.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..')
      return { ok: false, reason: 'That path is not a plain path inside the folder.' }
    if (segment.includes('\\') || CONTROL_CHARS.test(segment))
      return { ok: false, reason: 'That path is not a plain path inside the folder.' }
    if (platform === 'win32' && segment.includes(':'))
      return { ok: false, reason: 'That path is not a plain path inside the folder.' }
  }
  return { ok: true, segments }
}

export type LocationResult =
  { ok: true; path: string; root: string; exists: boolean } | { ok: false; reason: string }

/**
 * Resolves a location against the CURRENT grants. The result is refused unless
 * PathGuard allows it and its real path is exactly the path the names spell out:
 * a symlink, junction or 8.3 alias anywhere along the way changes the real
 * path, so nothing is ever reached through a link (even one that stays inside
 * the grants). Callers act on the returned `path` only.
 */
export async function resolveLocation(
  guard: PathGuard,
  location: FileLocation,
): Promise<LocationResult> {
  const root = rootForId(guard, location.rootId)
  if (!root) return { ok: false, reason: 'That folder is no longer granted.' }
  const rel = parseRel(location.rel, guard.platform)
  if (!rel.ok) return rel
  const joined = rel.segments.length > 0 ? guard.path.join(root, ...rel.segments) : root
  const syntax = checkPathSyntax(joined, guard.platform)
  if (syntax) return { ok: false, reason: syntax }
  const resolved = await guard.resolve(joined)
  if (!resolved.ok) return resolved
  if (!samePath(resolved.path, joined, guard.platform)) {
    return {
      ok: false,
      reason: `${location.rel || joined} is reached through a link or alias, which is not followed.`,
    }
  }
  return { ok: true, path: resolved.path, root, exists: resolved.exists }
}
