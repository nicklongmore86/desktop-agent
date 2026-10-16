import { lstatSync, watch as nodeWatch } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { discoverRepos, repoTarget } from './repo'
import { createGitRunner, type GitRunner } from './runner'

export interface GitServiceDeps {
  guard: PathGuard
  emit: (change: GitChanged) => void
  /** Opens a URL in the browser; only ever called with GIT_INSTALL_URL. */
  openUrl: (url: string) => Promise<void>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Makes the runner for a git executable (tests pass a fake). */
  runner?: (git: string) => GitRunner
  detect?: () => Promise<Detected>
  watch?: WatchFolder
}

/**
 * Watches a repository: its top folder (recursively where the OS does that cheaply:
 * Windows and macOS) and its .git folder, so commits, checkouts and staging show up.
 * Changes to git's own object store and lock files are ignored.
 */
export function repoWatchFolder(platform: NodeJS.Platform): WatchFolder {
  return (path, onChange, onError) => {
    const recursive = platform === 'win32' || platform === 'darwin'
    const handles = [
      nodeWatch(path, { persistent: false, recursive }, (_event, name) => {
        const file = (name ?? '').replace(/\\/g, '/')
        if (/^\.git\/(objects|logs)\//.test(file) || file.endsWith('.lock')) return
        onChange()
      }),
    ]
    try {
      // Only a real .git folder (a link would be followed; a worktree's .git is a file).
      if (!lstatSync(`${path}/.git`).isDirectory()) throw new Error('not a folder')
      handles.push(
        nodeWatch(`${path}/.git`, { persistent: false }, (_event, name) => {
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
  const runnerFor = deps.runner ?? ((git: string) => createGitRunner({ git, platform, env }))
  const detect =
    deps.detect ??
    (() =>
      detectGit({
        platform,
        env,
        grantedRoots: () => guard.grantedRoots(),
        runner: runnerFor,
        cwd: tmpdir(),
      }))

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

  const watcher = new FolderWatcher({
    async resolve(location) {
      const where = await resolveLocation(guard, location)
      return where.ok && where.exists ? where.path : null
    },
    isGranted: (id) => rootForId(guard, id) !== null,
    emit: deps.emit,
    watch: deps.watch ?? repoWatchFolder(platform),
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
    const run = runnerFor(detected.git)
    const config = await readRepoConfig(run, target.target)
    if (!config.ok)
      return { ok: false, code: config.refused ? 'refused' : 'failed', reason: config.reason }
    return { run, target: target.target, filters: config.filters, guard }
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
