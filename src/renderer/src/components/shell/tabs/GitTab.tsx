import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GrantsState } from '../../../../../shared/ipc'
import type {
  GitChange,
  GitCommit,
  GitDiffResult,
  GitOverview,
  GitRepoEntry,
  GitRepoRef,
  GitStatusResult,
} from '../../../../../shared/ipc-git'
import { useApi } from '../../../api'
import { useInsertFileReference } from '../../files/file-references'
import { GitChanges } from '../../git/GitChanges'
import { GitCommits } from '../../git/GitCommits'
import { GitDiff } from '../../git/GitDiff'
import { branchLabel } from '../../git/git-format'
import { SafeText } from '../../reveal'

/**
 * The views of a repository. A "Pull request" view (GitHub, a later change) slots in
 * here with its own label; the tab strip and keyboard handling need no change.
 */
const VIEWS = [
  { id: 'changes', label: 'Changes' },
  { id: 'commits', label: 'Commits' },
] as const
type ViewId = (typeof VIEWS)[number]['id']

const keyOf = (repo: GitRepoRef): string => `${repo.rootId}\n${repo.rel}`

/** A result and the repository (or repository and file) it belongs to. */
interface Keyed<T> {
  key: string
  value: T
  seq: number
}

interface LogState {
  commits: GitCommit[]
  more: boolean
  loading: boolean
  error: string | null
}
const EMPTY_LOG: LogState = { commits: [], more: false, loading: false, error: null }

/**
 * The Workspace panel's Git tab: read-only, local git. For the repositories in the
 * granted folders it shows the branch, changed files with their diffs, and recent
 * commits. Everything comes from main, which runs git with every repository setting
 * that could run a program switched off (src/main/git/runner.ts).
 */
export function GitTab({ grants }: { grants: GrantsState | null }): React.JSX.Element {
  const api = useApi()
  const insertReference = useInsertFileReference()
  const [overview, setOverview] = useState<GitOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<ViewId>('changes')
  // Results are kept with the repository (and file) they are for, so switching
  // repositories needs no reset and a late answer for another one is never shown.
  const [statusState, setStatusState] = useState<Keyed<GitStatusResult> | null>(null)
  const [openState, setOpenState] = useState<Keyed<GitChange> | null>(null)
  const [diffState, setDiffState] = useState<Keyed<GitDiffResult> | null>(null)
  const [logState, setLogState] = useState<Keyed<LogState> | null>(null)
  const logRequested = useRef<string | null>(null)
  const sequence = useRef(0)
  const viewButtons = useRef(new Map<ViewId, HTMLButtonElement>())

  const loadOverview = useCallback(() => {
    api.git.overview().then(
      (next) => {
        setOverview(next)
        setOverviewError(null)
      },
      () => {
        setOverviewError('Could not check for git repositories.')
      },
    )
  }, [api])

  useEffect(() => {
    loadOverview()
  }, [loadOverview, grants])

  const repos = useMemo<GitRepoEntry[]>(
    () => (overview?.git === 'found' ? overview.folders.flatMap((folder) => folder.repos) : []),
    [overview],
  )
  const repo =
    repos.find((entry) => keyOf(entry) === selected) ??
    repos.find((entry) => entry.kind === 'repo') ??
    repos[0] ??
    null
  const repoRef = useMemo(
    () => (repo?.kind === 'repo' ? { rootId: repo.rootId, rel: repo.rel } : null),
    [repo],
  )
  const usableKey = repoRef ? keyOf(repoRef) : null

  const status = statusState?.key === usableKey ? statusState.value : null
  const open = openState?.key === usableKey ? openState.value : null
  const log = logState?.key === usableKey ? logState.value : null
  const diffKey =
    open && statusState
      ? [usableKey, open.area, open.path, String(statusState.seq)].join('\0')
      : null
  const diff = diffState?.key === diffKey ? diffState.value : null

  const loadStatus = useCallback(() => {
    if (!repoRef || usableKey === null) return
    const done = (value: GitStatusResult): void => {
      setStatusState({ key: usableKey, value, seq: ++sequence.current })
    }
    api.git.status(repoRef).then(done, () => {
      done({ ok: false, code: 'failed', reason: 'Could not read the repository.' })
    })
  }, [api, repoRef, usableKey])

  const fetchLog = useCallback(
    (skip: number) => {
      if (!repoRef || usableKey === null) return
      api.git
        .log({ repo: repoRef, skip })
        .catch(() => ({ ok: false as const, reason: 'Could not read the history.' }))
        .then((result) => {
          setLogState((state) => {
            const previous = state?.key === usableKey ? state.value : EMPTY_LOG
            const value: LogState = result.ok
              ? {
                  commits: skip === 0 ? result.commits : [...previous.commits, ...result.commits],
                  more: result.more,
                  loading: false,
                  error: null,
                }
              : { ...previous, loading: false, error: result.reason }
            return { key: usableKey, value, seq: ++sequence.current }
          })
        })
        .catch(() => undefined)
    },
    [api, repoRef, usableKey],
  )

  // A repository is shown: read it and watch it.
  useEffect(() => {
    if (!repoRef) return
    loadStatus()
    void api.git.watch([repoRef])
    return () => {
      void api.git.watch([])
    }
  }, [api, repoRef, loadStatus])

  // The Commits view loads its first page when it is first shown.
  const logKey = logState?.key
  useEffect(() => {
    if (view !== 'commits' || usableKey === null || logKey === usableKey) return
    if (logRequested.current === usableKey) return
    logRequested.current = usableKey
    fetchLog(0)
  }, [view, usableKey, logKey, fetchLog])

  // Refresh on a change on disk and when the window comes back into focus.
  const refresh = useCallback(() => {
    loadStatus()
    if (view === 'commits') fetchLog(0)
  }, [loadStatus, fetchLog, view])
  useEffect(
    () =>
      api.git.onChanged((change) => {
        if (change.stopped) loadOverview()
        else if (keyOf(change) === usableKey) refresh()
      }),
    [api, refresh, loadOverview, usableKey],
  )
  useEffect(() => {
    const onFocus = (): void => {
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // The open file's diff, read again whenever the status is.
  useEffect(() => {
    if (!open || !repoRef || diffKey === null) return
    const done = (value: GitDiffResult): void => {
      setDiffState({ key: diffKey, value, seq: ++sequence.current })
    }
    api.git
      .diff({
        repo: repoRef,
        area: open.area,
        path: open.path,
        ...(open.oldPath !== undefined ? { oldPath: open.oldPath } : {}),
      })
      .then(done, () => {
        done({ ok: false, code: 'failed', reason: 'Could not read the diff.' })
      })
  }, [api, repoRef, open, diffKey])

  const setOpen = (change: GitChange | null): void => {
    setOpenState(change && usableKey !== null ? { key: usableKey, value: change, seq: 0 } : null)
  }
  const loadMore = (): void => {
    if (!log || usableKey === null) return
    setLogState({ key: usableKey, value: { ...log, loading: true }, seq: ++sequence.current })
    fetchLog(log.commits.length)
  }

  const reference = (change: GitChange): void => {
    if (!repoRef) return
    void insertReference({
      rootId: repoRef.rootId,
      rel: repoRef.rel ? `${repoRef.rel}/${change.path}` : change.path,
    })
  }

  const selectView = (id: ViewId): void => {
    setView(id)
    viewButtons.current.get(id)?.focus()
  }
  const onViewKey = (event: React.KeyboardEvent): void => {
    const index = VIEWS.findIndex((v) => v.id === view)
    const next =
      event.key === 'ArrowRight'
        ? VIEWS[(index + 1) % VIEWS.length]
        : event.key === 'ArrowLeft'
          ? VIEWS[(index + VIEWS.length - 1) % VIEWS.length]
          : undefined
    if (!next) return
    event.preventDefault()
    selectView(next.id)
  }

  let content: React.ReactNode
  if (overviewError) {
    content = (
      <p className="sidebar-error" role="alert">
        {overviewError}
      </p>
    )
  } else if (!overview) {
    content = <p className="sidebar-hint">Looking for git…</p>
  } else if (overview.git === 'missing') {
    content = (
      <div className="git-state" role="status">
        <p className="git-state-title">Git is not installed</p>
        <p className="sidebar-hint">
          {overview.detail ??
            'The Git panel uses Git for Windows to show branches, changes and commits. Nothing is bundled with this app.'}
        </p>
        <div className="git-state-actions">
          <button
            type="button"
            className="button-primary"
            onClick={() => {
              void api.git.openInstallPage()
            }}
          >
            Install Git for Windows
          </button>
          <button
            type="button"
            onClick={() => {
              loadOverview()
            }}
          >
            Check again
          </button>
        </div>
      </div>
    )
  } else if (overview.folders.length === 0) {
    content = (
      <div className="git-state">
        <p className="git-state-title">No folders granted</p>
        <p className="sidebar-hint">
          Grant a folder that holds a git repository to see its changes here.
        </p>
      </div>
    )
  } else if (!repo) {
    content = (
      <div className="git-state">
        <p className="git-state-title">No git repository</p>
        <p className="sidebar-hint">
          {overview.folders.length === 1
            ? 'This folder is not a git repository.'
            : 'None of the granted folders is a git repository.'}
        </p>
      </div>
    )
  } else if (repo.kind === 'refused') {
    content = (
      <div className="git-state" role="status">
        <p className="git-state-title">Repository not opened</p>
        <p className="sidebar-hint">
          <SafeText text={repo.reason} />
        </p>
      </div>
    )
  } else {
    content = (
      <>
        <RepoHeader status={status} onRefresh={refresh} />
        <div
          className="git-views"
          role="tablist"
          aria-label="Repository views"
          onKeyDown={onViewKey}
        >
          {VIEWS.map((v) => (
            <button
              key={v.id}
              ref={(element) => {
                if (element) viewButtons.current.set(v.id, element)
                else viewButtons.current.delete(v.id)
              }}
              type="button"
              role="tab"
              id={`git-view-${v.id}`}
              aria-selected={view === v.id}
              aria-controls="git-view-panel"
              tabIndex={view === v.id ? 0 : -1}
              onClick={() => {
                setView(v.id)
              }}
            >
              {v.label}
              {v.id === 'changes' && status?.ok && status.changes.length > 0 && (
                <span className="git-count">{status.changes.length + status.more}</span>
              )}
            </button>
          ))}
        </div>
        <div
          className="git-view"
          role="tabpanel"
          id="git-view-panel"
          aria-labelledby={`git-view-${view}`}
        >
          {view === 'changes' ? (
            !status ? (
              <p className="sidebar-hint">Reading changes…</p>
            ) : !status.ok ? (
              <p className="sidebar-error" role="alert">
                {status.reason}
              </p>
            ) : open ? (
              <GitDiff
                change={open}
                result={diff}
                onBack={() => {
                  setOpen(null)
                }}
              />
            ) : (
              <GitChanges
                changes={status.changes}
                more={status.more}
                onOpen={setOpen}
                onReference={reference}
              />
            )
          ) : (
            <GitCommits
              commits={log?.commits ?? []}
              more={log?.more ?? false}
              loading={!log || log.loading}
              error={log?.error ?? null}
              onMore={loadMore}
            />
          )}
        </div>
      </>
    )
  }

  return (
    <section className="git-tab" aria-labelledby="git-tab-title">
      <div className="files-header">
        <h2 id="git-tab-title" className="sidebar-label">
          Git
        </h2>
        {repos.length > 1 && (
          <select
            className="git-repo-select"
            aria-label="Repository"
            value={repo ? keyOf(repo) : ''}
            onChange={(event) => {
              setSelected(event.target.value)
            }}
          >
            {repos.map((entry) => (
              <option key={keyOf(entry)} value={keyOf(entry)}>
                {entry.rel ? entry.rel : entry.name}
                {entry.kind === 'refused' ? ' (not opened)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>
      {content}
    </section>
  )
}

function RepoHeader({
  status,
  onRefresh,
}: {
  status: GitStatusResult | null
  onRefresh: () => void
}): React.JSX.Element {
  const branch = status?.ok ? status.branch : null
  return (
    <div className="git-branch">
      <span className="git-branch-name" title="Current branch">
        <span aria-hidden="true">⎇ </span>
        <span className="visually-hidden">Branch: </span>
        {branch ? <SafeText text={branchLabel(branch)} /> : '…'}
      </span>
      {branch?.upstream !== undefined && branch.ahead !== undefined && (
        <span
          className="git-ahead-behind"
          title={`Compared with ${branch.upstream} as last fetched (nothing is fetched here)`}
        >
          <span aria-hidden="true">
            ↑{branch.ahead} ↓{branch.behind ?? 0}
          </span>
          <span className="visually-hidden">
            {branch.ahead} ahead, {branch.behind ?? 0} behind {branch.upstream}
          </span>
        </span>
      )}
      <button type="button" className="git-refresh" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  )
}
