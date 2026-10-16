// Reads the two things the runner must know about a repository's own config before
// running anything else in it: whether it includes other files (refused: an include
// can name any path, a \\server\share on Windows, and would make the list below
// incomplete) and the names of its filter drivers (each one's programs are then
// disabled on the command line, see gitInvocation).
import { CONTROL_CHARS } from '../files/location'
import {
  gitInvocation,
  type EmptyPaths,
  type FilterNames,
  type GitRunner,
  type GitTarget,
} from './runner'

/** Most filter drivers a repository may define. */
const MAX_FILTERS = 64

export type RepoConfig =
  { ok: true; filters: FilterNames } | { ok: false; reason: string; refused: boolean }

/** The argument list of the config read: includes off, so it reads the repository's files only. */
export function configInvocation(target: GitTarget, empty: EmptyPaths): string[] {
  return gitInvocation(
    target,
    [],
    ['config', '--no-includes', '-z', '--get-regexp', '^(include|includeif|filter)\\.'],
    empty,
  )
}

/** Parses `git config -z --get-regexp` output (`key\nvalue\0` records). Exported for tests. */
export function parseConfigKeys(output: string): string[] {
  return output
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const newline = record.indexOf('\n')
      return newline === -1 ? record : record.slice(0, newline)
    })
}

/** Filter names from config keys, or why the repository is refused. Exported for tests. */
export function filtersFromKeys(keys: readonly string[]): RepoConfig {
  const filters = new Set<string>()
  for (const key of keys) {
    const lower = key.toLowerCase()
    if (lower.startsWith('include.') || lower.startsWith('includeif.'))
      return {
        ok: false,
        refused: true,
        reason:
          "This repository's settings include other files, so the Git panel does not open it.",
      }
    if (!lower.startsWith('filter.')) continue
    // filter.<name>.<setting>: the name may itself contain dots.
    const name = key.slice('filter.'.length, key.lastIndexOf('.'))
    if (name === '' || name.includes('=') || CONTROL_CHARS.test(name))
      return {
        ok: false,
        refused: true,
        reason: 'This repository defines a filter the Git panel cannot switch off safely.',
      }
    filters.add(name)
  }
  if (filters.size > MAX_FILTERS)
    return { ok: false, refused: true, reason: 'This repository defines too many filters.' }
  return { ok: true, filters: [...filters] }
}

export async function readRepoConfig(
  run: GitRunner,
  target: GitTarget,
  empty: EmptyPaths,
): Promise<RepoConfig> {
  const result = await run(configInvocation(target, empty), target.root, { maxBytes: 262_144 })
  if (result.truncated)
    return { ok: false, refused: true, reason: "This repository's settings are too large." }
  // Exit 1: no key matched.
  if (result.code === 1 && result.stdout.length === 0) return { ok: true, filters: [] }
  if (result.code !== 0)
    return { ok: false, refused: false, reason: gitFailure(result.stderr, result.timedOut) }
  return filtersFromKeys(parseConfigKeys(result.stdout.toString('utf8')))
}

/** A user-facing message for a failed git run. */
export function gitFailure(stderr: string, timedOut: boolean): string {
  if (timedOut) return 'Git took too long to answer.'
  if (/dubious ownership/i.test(stderr))
    return 'Git refuses this repository because it belongs to another user (see "safe.directory" in the Git documentation).'
  const line = stderr
    .split(/\r?\n/)
    .map((text) => text.replace(/^(fatal|error): /, '').trim())
    .find((text) => text !== '')
  return line ? `Git failed: ${line.slice(0, 300)}` : 'Git failed.'
}
