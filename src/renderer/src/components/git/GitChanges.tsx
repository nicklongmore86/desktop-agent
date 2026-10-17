import type { GitChange, GitChangeArea } from '../../../../shared/ipc-git'
import { FileIcon } from '../files/FileIcon'
import { SafeText } from '../reveal'
import { AREA_LABELS, STATUS_MARKS, describeChange, splitPath } from './git-format'

const AREAS: GitChangeArea[] = ['staged', 'unstaged', 'untracked']

/** Why a changed file cannot be added to the chat as a reference, or null. */
export function referenceBlock(change: GitChange): string | null {
  if (change.unsafeName) return 'This name cannot be used safely.'
  if (change.hidden) return change.hidden
  if (change.status === 'deleted') return 'The file no longer exists.'
  return null
}

/**
 * The changed files, grouped Staged / Changes / Untracked. Each row opens the file's
 * diff; the @ button puts a reference to it into the message box (main checks it again).
 */
export function GitChanges({
  changes,
  more,
  onOpen,
  onReference,
}: {
  changes: GitChange[]
  more: number
  onOpen: (change: GitChange) => void
  onReference: (change: GitChange) => void
}): React.JSX.Element {
  if (changes.length === 0)
    return <p className="sidebar-hint git-empty">No changes. The working tree is clean.</p>
  return (
    <div className="git-changes">
      {AREAS.map((area) => {
        const rows = changes.filter((change) => change.area === area)
        if (rows.length === 0) return null
        const headingId = `git-area-${area}`
        return (
          <section key={area} aria-labelledby={headingId}>
            <h3 id={headingId} className="git-area">
              {AREA_LABELS[area]} <span className="git-count">{rows.length}</span>
            </h3>
            <ul className="git-list">
              {rows.map((change) => {
                const { name, dir } = splitPath(change.path)
                const mark = STATUS_MARKS[change.status]
                const blocked = referenceBlock(change)
                const locked = Boolean(change.hidden || change.unsafeName)
                return (
                  <li key={`${area}\n${change.path}`} className="git-row">
                    <button
                      type="button"
                      className={`git-row-main${change.status === 'deleted' ? ' git-row-deleted' : ''}`}
                      onClick={() => {
                        onOpen(change)
                      }}
                    >
                      <FileIcon name={name} kind="file" locked={locked} />
                      <span className="git-name">
                        <SafeText text={name} />
                      </span>
                      {dir && (
                        <span className="git-dir">
                          <SafeText text={dir} />
                        </span>
                      )}
                      <span className="git-row-end">
                        {change.additions !== undefined && !change.hidden && (
                          <span className="git-counts" aria-hidden="true">
                            <span className="git-plus">+{change.additions}</span>{' '}
                            <span className="git-minus">−{change.deletions ?? 0}</span>
                          </span>
                        )}
                        {locked && (
                          <span className="tree-badge" aria-hidden="true">
                            hidden
                          </span>
                        )}
                        <span
                          className={`git-status git-${mark.tone}`}
                          aria-hidden="true"
                          title={mark.label}
                        >
                          {mark.letter}
                        </span>
                      </span>
                      <span className="visually-hidden">, {describeChange(change)}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button git-ref"
                      aria-label={`Insert reference to ${change.path} into chat`}
                      title={blocked ?? 'Insert reference into chat'}
                      aria-disabled={blocked ? 'true' : undefined}
                      onClick={() => {
                        if (!blocked) onReference(change)
                      }}
                    >
                      @
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
      {more > 0 && (
        <p className="sidebar-hint">
          {more} more changed {more === 1 ? 'file is' : 'files are'} not listed.
        </p>
      )}
    </div>
  )
}
