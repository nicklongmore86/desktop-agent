// Name search over the granted folders for the composer's `@` menu. Uses the
// tools' walk (guarded, never follows links, skips the blocklist), bounded by
// depth, entries visited and time so a huge folder cannot stall typing.
import { FILES_SEARCH_LIMIT, type FileSearchHit } from '../../shared/ipc-files'
import type { PathGuard } from '../permissions/guard'
import { walk } from '../tools/walk'
import { rootId } from './location'
import { isSecretName } from './secret-names'

/** Folders that are noise for a mention search; never descended into. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv'])

export interface SearchLimits {
  maxDepth: number
  /** Entries visited across all granted folders. */
  maxVisited: number
  ms: number
  results: number
}

export const SEARCH_LIMITS: SearchLimits = {
  maxDepth: 8,
  maxVisited: 20_000,
  ms: 1500,
  results: FILES_SEARCH_LIMIT,
}

function score(name: string, query: string): number {
  const lower = name.toLowerCase()
  if (lower === query) return 0
  if (lower.startsWith(query)) return 1
  const stem = lower.lastIndexOf('.') > 0 ? lower.slice(0, lower.lastIndexOf('.')) : lower
  if (stem.split(/[-_. ]/).some((word) => word.startsWith(query))) return 2
  return 3
}

/**
 * Files and folders inside the granted folders whose name contains `query`
 * (ignoring case), best matches first: exact name, prefix, word prefix, then
 * anywhere; ties go to the shallower path. Secret files and files with other
 * hard links are left out (they cannot be referenced).
 */
export async function searchFiles(
  guard: PathGuard,
  query: string,
  limits: SearchLimits = SEARCH_LIMITS,
): Promise<FileSearchHit[]> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const signal = AbortSignal.timeout(limits.ms)
  const hits: (FileSearchHit & { score: number })[] = []
  let visited = 0
  for (const root of guard.grantedRoots()) {
    const resolved = await guard.resolve(root)
    if (!resolved.ok || !guard.isRoot(resolved.path)) continue
    const rootName = guard.path.basename(root) || root
    for await (const entry of walk(resolved.path, guard, {
      maxDepth: limits.maxDepth,
      signal,
      skipDirs: SKIP_DIRS,
    })) {
      if (++visited > limits.maxVisited) break
      if (entry.kind !== 'file' && entry.kind !== 'dir') continue
      if (!entry.name.toLowerCase().includes(needle)) continue
      if (entry.kind === 'file' && (isSecretName(entry.name) || entry.nlink > 1)) continue
      hits.push({
        rootId: rootId(root),
        rel: entry.rel,
        name: entry.name,
        kind: entry.kind,
        rootName,
        score: score(entry.name, needle),
      })
    }
    if (visited > limits.maxVisited || signal.aborted) break
  }
  hits.sort(
    (a, b) =>
      a.score - b.score ||
      a.rel.split('/').length - b.rel.split('/').length ||
      a.rel.localeCompare(b.rel),
  )
  return hits.slice(0, limits.results).map(({ score: _score, ...hit }) => hit)
}
