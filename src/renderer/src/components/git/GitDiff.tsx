import type { GitChange, GitDiffResult } from '../../../../shared/ipc-git'
import { DiffView } from '../DiffView'
import { SafeText } from '../reveal'
import { AREA_LABELS, STATUS_MARKS } from './git-format'

const MESSAGES = {
  binary: 'Binary file changed. Its contents are not shown.',
  empty: 'No line changes (only the file mode or nothing at all changed).',
  'too-large': 'Diff too large to show here.',
} as const

/** One changed file's diff, as plain text (DiffView), or why it is not shown. */
export function GitDiff({
  change,
  result,
  onBack,
}: {
  change: GitChange
  result: GitDiffResult | null
  onBack: () => void
}): React.JSX.Element {
  const mark = STATUS_MARKS[change.status]
  let body: React.ReactNode
  if (!result) body = <p className="sidebar-hint">Loading diff…</p>
  else if (!result.ok)
    body = (
      <p className="sidebar-error" role="alert">
        {result.reason}
      </p>
    )
  else if (result.kind === 'text')
    body = (
      <>
        {result.redacted && (
          <p className="sidebar-hint">Values that look like secrets are hidden as [REDACTED].</p>
        )}
        <DiffView diff={result.diff} />
      </>
    )
  else if (result.kind === 'hidden')
    body = <p className="sidebar-hint git-hidden">Contents hidden: {result.reason}</p>
  else body = <p className="sidebar-hint">{MESSAGES[result.kind]}</p>

  return (
    <section className="git-diff" aria-label={`Diff of ${change.path}`}>
      <div className="git-diff-header">
        <button type="button" onClick={onBack}>
          ← Changes
        </button>
        <span className="git-diff-title">
          <SafeText text={change.path} />
        </span>
        <span className={`git-status git-${mark.tone}`} title={mark.label}>
          {mark.letter}
        </span>
        <span className="visually-hidden">
          {mark.label}, {AREA_LABELS[change.area].toLowerCase()}
        </span>
      </div>
      {change.oldPath !== undefined && (
        <p className="sidebar-hint">
          Renamed from <SafeText text={change.oldPath} />
        </p>
      )}
      {body}
    </section>
  )
}
