// One level of a granted folder, for the Workspace panel's tree. A UI listing,
// separate from the agent's list_dir output, built on the same rules: resolve
// through PathGuard, never follow links, never stat blocklisted entries.
import { promises as nodeFs } from 'node:fs'
import {
  FILES_MAX_ENTRIES,
  type FileEntry,
  type FileLocation,
  type FilesListResult,
} from '../../shared/ipc-files'
import type { PathGuard } from '../permissions/guard'
import { parseRel, resolveLocation } from './location'
import { isSecretName } from './secret-names'

export interface ListStats {
  isSymbolicLink(): boolean
  isDirectory(): boolean
  isFile(): boolean
  size: number
  mtimeMs: number
  nlink: number
}

/** The file-system calls a listing makes; injectable so tests can fake Windows on Linux. */
export interface ListFs {
  readdir(p: string): Promise<string[]>
  lstat(p: string): Promise<ListStats>
}

export const nodeListFs: ListFs = {
  readdir: (p) => nodeFs.readdir(p),
  lstat: (p) => nodeFs.lstat(p),
}

/** How many entries are lstat'ed at once. */
const LSTAT_BATCH = 64

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'unknown error'
}

const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || (a < b ? -1 : 1)

/**
 * Lists one folder inside the grants. The folder is resolved through
 * PathGuard (see resolveLocation); its entries are classified without being
 * opened: blocklisted ones by name only (never stat'ed), links as links (their
 * target is checked against the grants but never listed), files with other
 * hard links flagged. Folders come first, then files, each by name. Only the
 * first FILES_MAX_ENTRIES names are returned; `more` counts the rest.
 */
export async function listFolder(
  guard: PathGuard,
  location: FileLocation,
  fs: ListFs = nodeListFs,
  maxEntries: number = FILES_MAX_ENTRIES,
): Promise<FilesListResult> {
  const where = await resolveLocation(guard, location)
  if (!where.ok) return where
  if (!where.exists) return { ok: false, reason: 'That folder no longer exists.' }
  const dir = where.path
  let names: string[]
  try {
    const stats = await fs.lstat(dir)
    if (stats.isSymbolicLink() || !stats.isDirectory())
      return { ok: false, reason: 'That is not a folder.' }
    names = (await fs.readdir(dir)).sort(byName)
  } catch (error) {
    return { ok: false, reason: `Could not list the folder (${codeOf(error)}).` }
  }
  const more = Math.max(0, names.length - maxEntries)
  names = names.slice(0, maxEntries)

  const P = guard.path
  const prefix = location.rel === '' ? '' : `${location.rel}/`
  const entries: FileEntry[] = []
  for (let start = 0; start < names.length; start += LSTAT_BATCH) {
    const batch = await Promise.all(
      names.slice(start, start + LSTAT_BATCH).map(async (name): Promise<FileEntry | null> => {
        const rel = `${prefix}${name}`
        const path = P.join(dir, name)
        // A revoked grant stops the listing.
        if (!guard.isWithinGrants(path)) return null
        const blocked = guard.blockedReason(path)
        if (blocked) return { name, rel, kind: 'other', denied: blocked }
        if (!parseRel(rel, guard.platform).ok)
          return { name, rel, kind: 'other', denied: 'This name cannot be used safely.' }
        let stats: ListStats
        try {
          stats = await fs.lstat(path)
        } catch (error) {
          return { name, rel, kind: 'other', denied: `Cannot be read (${codeOf(error)}).` }
        }
        const mtimeMs = stats.mtimeMs
        if (stats.isSymbolicLink()) {
          const target = await guard.resolve(path)
          return { name, rel, kind: 'link', mtimeMs, linkOutside: !target.ok }
        }
        if (stats.isDirectory()) return { name, rel, kind: 'dir', mtimeMs }
        if (!stats.isFile()) return { name, rel, kind: 'other', mtimeMs }
        return {
          name,
          rel,
          kind: 'file',
          size: stats.size,
          mtimeMs,
          ...(isSecretName(name) ? { secret: true } : {}),
          ...(stats.nlink > 1 ? { hardLink: true } : {}),
        }
      }),
    )
    for (const entry of batch) {
      if (!entry) return { ok: false, reason: 'That folder is no longer granted.' }
      entries.push(entry)
    }
  }
  entries.sort(
    (a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || byName(a.name, b.name),
  )
  return { ok: true, entries, more }
}
