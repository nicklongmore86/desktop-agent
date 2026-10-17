import type {
  GitBranch,
  GitChange,
  GitChangeArea,
  GitChangeStatus,
} from '../../../../shared/ipc-git'

/** The letter badge and the colour class (`git-<tone>`, a --color-git-* token) of a status. */
export const STATUS_MARKS: Record<
  GitChangeStatus,
  { letter: string; label: string; tone: string }
> = {
  added: { letter: 'A', label: 'Added', tone: 'added' },
  modified: { letter: 'M', label: 'Modified', tone: 'modified' },
  deleted: { letter: 'D', label: 'Deleted', tone: 'deleted' },
  renamed: { letter: 'R', label: 'Renamed', tone: 'renamed' },
  copied: { letter: 'C', label: 'Copied', tone: 'renamed' },
  typechange: { letter: 'T', label: 'Type changed', tone: 'modified' },
  untracked: { letter: 'U', label: 'Untracked', tone: 'untracked' },
  conflicted: { letter: '!', label: 'Conflicted', tone: 'deleted' },
}

export const AREA_LABELS: Record<GitChangeArea, string> = {
  staged: 'Staged',
  unstaged: 'Changes',
  untracked: 'Untracked',
}

/** A changed file's name and the folder it is in ('' at the top). */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

/** The accessible description of a changed file's row. */
export function describeChange(change: GitChange): string {
  const parts = [STATUS_MARKS[change.status].label, AREA_LABELS[change.area].toLowerCase()]
  if (change.oldPath !== undefined) parts.push(`from ${change.oldPath}`)
  if (change.hidden) parts.push('contents hidden')
  else if (change.binary) parts.push('binary')
  else if (change.additions !== undefined)
    parts.push(`${String(change.additions)} added, ${String(change.deletions ?? 0)} removed`)
  return parts.join(', ')
}

/** The branch as one line: the name, or the detached commit, or "no commits yet". */
export function branchLabel(branch: GitBranch): string {
  if (branch.oid === null) return `${branch.head ?? 'HEAD'} (no commits yet)`
  if (branch.head === null) return `Detached at ${branch.oid.slice(0, 7)}`
  return branch.head
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "3 days ago", "just now". */
export function relativeDate(ms: number, now: number = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000)
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}
