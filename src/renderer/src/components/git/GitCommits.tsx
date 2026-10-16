import type { GitCommit } from '../../../../shared/ipc-git'
import { SafeText } from '../reveal'
import { relativeDate } from './git-format'

/** Recent commits on HEAD: subject, short hash, author and when. Text is untrusted. */
export function GitCommits({
  commits,
  more,
  loading,
  error,
  onMore,
}: {
  commits: GitCommit[]
  more: boolean
  loading: boolean
  error: string | null
  onMore: () => void
}): React.JSX.Element {
  return (
    <div className="git-commits">
      {commits.length === 0 && !loading && !error && (
        <p className="sidebar-hint git-empty">No commits yet.</p>
      )}
      {commits.length > 0 && (
        <ol className="git-list" aria-label="Recent commits">
          {commits.map((commit) => (
            <li key={commit.hash} className="git-commit">
              <span className="git-commit-subject">
                <SafeText text={commit.subject || '(no message)'} />
              </span>
              <span className="git-commit-meta">
                <code className="git-hash">{commit.short}</code>
                <span className="git-author">
                  <SafeText text={commit.author} />
                </span>
                <time
                  dateTime={new Date(commit.date).toISOString()}
                  title={new Date(commit.date).toLocaleString()}
                >
                  {relativeDate(commit.date)}
                </time>
                {commit.merge && <span className="tree-badge">merge</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="sidebar-hint">Loading commits…</p>}
      {more && !loading && (
        <button type="button" className="git-more" onClick={onMore}>
          Load more commits
        </button>
      )}
    </div>
  )
}
