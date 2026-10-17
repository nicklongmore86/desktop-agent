/**
 * The Workspace panel's Git tab (read-only, local git only): channel names, types and
 * limits shared by main, preload and renderer. One of the per-feature IPC modules; see
 * docs/ipc-modules.md.
 *
 * Like the Files tree, the renderer never sends an absolute path. A repository is named
 * by the granted folder's opaque id and the `/`-separated path of the repository's top
 * folder inside it (`rel`, '' when the granted folder is the repository). A changed file
 * is named by its path inside the repository, exactly as main listed it. Main checks
 * everything again against the current grants on every call.
 */
import type { FileLocation } from './ipc-files'

export const gitChannels = {
  gitOverview: 'git:overview',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitLog: 'git:log',
  gitWatch: 'git:watch',
  gitOpenInstallPage: 'git:open-install-page',
} as const

/** Main -> renderer: a watched repository changed on disk (or its watcher stopped). */
export const gitPushChannels = {
  gitChanged: 'git:changed',
} as const

/** Where "Install Git" goes. Main opens this fixed address; the renderer never sends a URL. */
export const GIT_INSTALL_URL = 'https://git-scm.com/downloads/win'
/** Most changed files one status returns; the rest are counted in `more`. */
export const GIT_MAX_CHANGES = 1000
/** Commits per page of the Commits list. */
export const GIT_LOG_PAGE = 50
/** Furthest the Commits list pages back. */
export const GIT_LOG_MAX_SKIP = 100_000
/** A file's diff larger than this (bytes of diff text) shows "Diff too large". */
export const GIT_DIFF_MAX_BYTES = 200_000
/** ...or longer than this (lines). */
export const GIT_DIFF_MAX_LINES = 4000
/** Most repositories the panel watches at once. */
export const GIT_MAX_WATCHED = 8
/** Longest repository-relative path main accepts, in characters. */
export const GIT_MAX_PATH = 4096

/** A repository: the granted folder's id and the repository's top folder inside it. */
export type GitRepoRef = FileLocation

/**
 * A repository found in a granted folder.
 * - `repo`: usable.
 * - `refused`: the panel will not run git in it, and `reason` says why (its `.git` is a
 *   link or points outside the granted folders, it borrows objects from elsewhere, its
 *   settings include other files, or the granted folder is inside a repository whose
 *   top folder is not granted).
 */
export type GitRepoEntry = GitRepoRef & {
  /** The repository's folder name, for display. */
  name: string
  /** The full path, for display only; calls use `rootId` and `rel`. */
  path: string
} & ({ kind: 'repo' } | { kind: 'refused'; reason: string })

/** A granted folder and the repositories in it (none: not a git repository). */
export interface GitFolder {
  rootId: string
  name: string
  path: string
  repos: GitRepoEntry[]
}

export type GitOverview =
  | {
      git: 'missing'
      /** Why, e.g. "Git 2.20 is too old"; absent when no git was found at all. */
      detail?: string
    }
  | { git: 'found'; version: string; folders: GitFolder[] }

export interface GitBranch {
  /** The branch name, or null for a detached HEAD. */
  head: string | null
  /** The commit HEAD is at, or null in a repository with no commits yet. */
  oid: string | null
  /** The tracking branch (e.g. origin/main), when one is set. */
  upstream?: string
  /** Commits ahead of / behind the tracking branch, from local refs only (nothing is fetched). */
  ahead?: number
  behind?: number
}

export type GitChangeArea = 'staged' | 'unstaged' | 'untracked'

export type GitChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted'

/**
 * One changed file. A file staged and then changed again appears twice: once as
 * `staged`, once as `unstaged`.
 * - `hidden`: the panel shows the name and status only, never the contents, and says
 *   why (a secrets file like `.env`, a blocklisted name, a link, a file with other
 *   hard links, a name that cannot be used safely).
 * - `unsafeName`: the name has control characters or is not valid text; it cannot be
 *   diffed or referenced.
 */
export interface GitChange {
  area: GitChangeArea
  status: GitChangeStatus
  /** `/`-separated path inside the repository. */
  path: string
  /** The previous path of a renamed or copied file. */
  oldPath?: string
  /** Lines added and removed (absent for binary, hidden and untracked files). */
  additions?: number
  deletions?: number
  binary?: boolean
  hidden?: string
  unsafeName?: boolean
}

export type GitFailure = {
  ok: false
  reason: string
  /**
   * `git-missing`: git is not installed (any more); `refused`: the repository is not
   * used (see GitRepoEntry); `gone`: the folder or grant no longer exists; `failed`:
   * git ran and failed or timed out.
   */
  code: 'git-missing' | 'refused' | 'gone' | 'failed'
}

export type GitStatusResult =
  | {
      ok: true
      branch: GitBranch
      changes: GitChange[]
      /** Changed files past GIT_MAX_CHANGES, not returned. */
      more: number
    }
  | GitFailure

export interface GitDiffRequest {
  repo: GitRepoRef
  area: GitChangeArea
  path: string
  /** For a renamed or copied staged file: its previous path. */
  oldPath?: string | undefined
}

export type GitDiffResult =
  | {
      ok: true
      kind: 'text'
      /** Unified diff text, shown as plain text. Never HTML. */
      diff: string
      /** True when values that look like secrets were masked. */
      redacted: boolean
    }
  | { ok: true; kind: 'binary' | 'empty' | 'too-large' }
  /** Name and status only: `reason` says why the contents are not shown. */
  | { ok: true; kind: 'hidden'; reason: string }
  | GitFailure

export interface GitCommit {
  hash: string
  short: string
  author: string
  /** Author date, ms since the epoch. */
  date: number
  subject: string
  /** True for a merge commit. */
  merge: boolean
}

export interface GitLogRequest {
  repo: GitRepoRef
  /** Commits to skip (for "Load more"). */
  skip: number
}

export type GitLogResult = { ok: true; commits: GitCommit[]; more: boolean } | GitFailure

/** Pushed when a watched repository changed (the renderer refreshes it) or its watcher stopped. */
export interface GitChanged extends GitRepoRef {
  stopped?: boolean
}

export interface GitApi {
  git: {
    /** Whether git is installed, and the repositories in each granted folder. */
    overview: () => Promise<GitOverview>
    /** Branch and changed files. Reads only; nothing in the repository is written. */
    status: (repo: GitRepoRef) => Promise<GitStatusResult>
    /** One changed file's diff, capped and with secret-looking values masked. */
    diff: (request: GitDiffRequest) => Promise<GitDiffResult>
    /** A page of recent commits on HEAD. */
    log: (request: GitLogRequest) => Promise<GitLogResult>
    /** Replaces the set of watched repositories. */
    watch: (repos: GitRepoRef[]) => Promise<void>
    /** Opens the Git for Windows download page (a fixed address) in the browser. */
    openInstallPage: () => Promise<void>
    onChanged: (listener: (change: GitChanged) => void) => () => void
  }
}
