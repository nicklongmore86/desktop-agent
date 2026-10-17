import { lstatSync, watch as nodeWatch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GIT_INSTALL_URL,
  GIT_MAX_WATCHED,
  type GitChanged,
  type GitFailure,
  type GitRepoRef,
} from '../../shared/ipc-git'
import type { GitService } from '../ipc-git'
import { resolveLocation, rootForId } from '../files/location'
import { FolderWatcher, type WatchFolder } from '../files/watcher'
import type { PathGuard } from '../permissions/guard'
import { detectGit, type Detected } from './detect'
import { gitDiff, gitLog, gitStatus, type QueryContext } from './queries'
import { readRepoConfig } from './repo-config'
import { checkRepo, discoverRepos, repoTarget } from './repo'
import {
  createGitRunner,
  DEVICE_EMPTY,
  ensureEmptyPaths,
  type EmptyPaths,
  type GitRunner,
} from './runner'

export interface GitServiceDeps {
  guard: PathGuard
  emit: (change: GitChanged) => void
  /** Opens a URL in the browser; only ever called with GIT_INSTALL_URL. */
  openUrl: (url: string) => Promise<void>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /**
   * A folder of the app's own (userData) for the empty file and empty hooks folder
   * git is pointed at on Windows (see EmptyPaths). Defaults to one in the temp folder.
   */
  emptyDir?: string
  /** 'device' (/dev/null) or 'app' (emptyDir); default: 'app' on Windows only. */
  emptyMode?: 'device' | 'app'
  /** Makes the runner for a git executable (tests pass a fake). */
  runner?: (git: string, empty: EmptyPaths) => GitRunner
  detect?: () => Promise<Detected>
  watch?: WatchFolder
}

/**
 * Watches a repository: its top folder (recursively where the OS does that cheaply:
 * Windows and macOS) and its .git folder, so commits, checkouts and staging show up.
 * Changes to git's own object store and lock files are ignored.
 */
export function repoWatchFolder(
  platform: NodeJS.Platform,
  gitDirOf: (root: string) => string | undefined = () => undefined,
): WatchFolder {
  return (path, onChange, onError) => {
    const recursive = platform === 'win32' || platform === 'darwin'
    const handles = [
      nodeWatch(path, { persistent: false, recursive }, (_event, name) => {
        const file = (name ?? '').replace(/\\/g, '/')
        if (/^\.git\/(objects|logs)\//.test(file) || file.endsWith('.lock')) return
        onChange()
      }),
    ]
    // The git folder: `.git`, or a worktree's checked git folder (its `.git` is a file).
    const gitDir = gitDirOf(path) ?? join(path, '.git')
    try {
      // Only a real folder: a link would be followed.
      if (!lstatSync(gitDir).isDirectory()) throw new Error('not a folder')
      handles.push(
        nodeWatch(gitDir, { persistent: false }, (_event, name) => {
          if (!(name ?? '').endsWith('.lock')) onChange()
        }),
      )
    } catch {
      // No .git folder to watch: the top folder's watcher still runs.
    }
    for (const handle of handles) handle.on('error', onError)
    return {
      close: () => {
        for (const handle of handles) handle.close()
      },
    }
  }
}

/** The Git panel, as main provides it: read-only, local git only. */
export function createGitService(deps: GitServiceDeps): GitService & { close(): void } {
  const { guard } = deps
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const runnerFor =
    deps.runner ??
    ((git: string, empty: EmptyPaths) => createGitRunner({ git, platform, env, empty }))
  const emptyMode = deps.emptyMode ?? (platform === 'win32' ? 'app' : 'device')
  const emptyDir = deps.emptyDir ?? join(tmpdir(), 'desktop-agent-git-empty')
  const emptyPaths = (): Promise<EmptyPaths> =>
    emptyMode === 'device' ? Promise.resolve(DEVICE_EMPTY) : ensureEmptyPaths(emptyDir)
  const detect =
    deps.detect ??
    (async () => {
      const empty = await emptyPaths()
      return detectGit({
        platform,
        env,
        grantedRoots: () => guard.grantedRoots(),
        runner: (path) => runnerFor(path, empty),
        cwd: tmpdir(),
      })
    })

  // A found git is kept; a missing one is looked for again on the next call (the
  // user may have just installed it).
  let found: Promise<Detected> | null = null
  const git = async (): Promise<Detected> => {
    const current = found ?? detect()
    found = current
    const result = await current
    if (!result.ok) found = null
    return result
  }

  // A watched repository's checked git folder, so a worktree's is watched too.
  const gitDirs = new Map<string, string>()
  const watcher = new FolderWatcher({
    async resolve(location) {
      const where = await resolveLocation(guard, location)
      if (!where.ok || !where.exists) return null
      const check = await checkRepo(guard, where.path)
      if (check.ok) gitDirs.set(where.path, check.target.gitDir)
      return where.path
    },
    isGranted: (id) => rootForId(guard, id) !== null,
    emit: deps.emit,
    watch: deps.watch ?? repoWatchFolder(platform, (root) => gitDirs.get(root)),
    debounceMs: 500,
    max: GIT_MAX_WATCHED,
  })

  /** Everything a read needs, or the failure to return instead. */
  const prepare = async (repo: GitRepoRef): Promise<QueryContext | GitFailure> => {
    const detected = await git()
    if (!detected.ok)
      return { ok: false, code: 'git-missing', reason: detected.detail ?? 'Git is not installed.' }
    const target = await repoTarget(guard, repo)
    if (!target.ok)
      return { ok: false, code: 'gone' in target ? 'gone' : 'refused', reason: target.reason }
    let empty: EmptyPaths
    try {
      empty = await emptyPaths()
    } catch {
      return { ok: false, code: 'failed', reason: 'Could not prepare git’s empty settings.' }
    }
    const run = runnerFor(detected.git, empty)
    const config = await readRepoConfig(run, target.target, empty)
    if (!config.ok)
      return { ok: false, code: config.refused ? 'refused' : 'failed', reason: config.reason }
    return { run, target: target.target, filters: config.filters, guard, empty }
  }
  const isFailure = (value: QueryContext | GitFailure): value is GitFailure => 'ok' in value

  return {
    async overview() {
      const detected = await git()
      if (!detected.ok)
        return detected.detail ? { git: 'missing', detail: detected.detail } : { git: 'missing' }
      return { git: 'found', version: detected.version, folders: await discoverRepos(guard) }
    },
    async status(repo) {
      const ctx = await prepare(repo)
      return isFailure(ctx) ? ctx : gitStatus(ctx)
    },
    async diff(request) {
      const ctx = await prepare(request.repo)
      return isFailure(ctx) ? ctx : gitDiff(ctx, request)
    },
    async log(request) {
      const ctx = await prepare(request.repo)
      return isFailure(ctx) ? ctx : gitLog(ctx, request.skip)
    },
    watch: (repos) => watcher.sync(repos),
    openInstallPage: () => deps.openUrl(GIT_INSTALL_URL),
    close: () => {
      watcher.close()
    },
  }
}
