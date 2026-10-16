// Finds the git repositories in the granted folders and checks each one before git
// ever runs in it. Everything git will read must be inside the grants: the working
// tree, the git directory (a `.git` file's `gitdir:` pointer, a worktree's `commondir`)
// and the object store (no `alternates`). Links anywhere on that path are refused,
// since git would follow them. Only lstat and small reads happen here; git does not run.
import { promises as fs } from 'node:fs'
import type { GitFolder, GitRepoEntry, GitRepoRef } from '../../shared/ipc-git'
import { CONTROL_CHARS, filesRoots, resolveLocation } from '../files/location'
import type { PathGuard } from '../permissions/guard'
import { checkPathSyntax, samePath } from '../permissions/paths'
import type { GitTarget } from './runner'

/** Most repositories listed directly inside one granted folder. */
export const MAX_CHILD_REPOS = 32
/** Most entries of a granted folder looked at for repositories. */
const MAX_CHILD_SCAN = 2000
/** Longest `.git` or `commondir` pointer file read. */
const MAX_POINTER = 4096

export type RepoCheck =
  { ok: true; target: GitTarget } | { ok: false; reason: string; notRepo?: true }

type Kind = 'missing' | 'link' | 'dir' | 'file' | 'other'

async function kindOf(path: string): Promise<Kind> {
  try {
    const stats = await fs.lstat(path)
    if (stats.isSymbolicLink()) return 'link'
    if (stats.isDirectory()) return 'dir'
    if (stats.isFile()) return 'file'
    return 'other'
  } catch {
    return 'missing'
  }
}

async function readPointer(path: string): Promise<string | null> {
  try {
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(MAX_POINTER)
      const { bytesRead } = await handle.read(buffer, 0, MAX_POINTER, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Resolves a path a repository file points to (relative to `base`) and accepts it only
 * when PathGuard allows it, it exists, and its real path is the path as written (no
 * link or junction on the way).
 */
async function pointerTarget(
  guard: PathGuard,
  base: string,
  pointer: string,
): Promise<string | null> {
  if (pointer === '' || CONTROL_CHARS.test(pointer)) return null
  const P = guard.path
  const joined = P.resolve(base, pointer)
  if (checkPathSyntax(joined, guard.platform)) return null
  const resolved = await guard.resolve(joined)
  if (!resolved.ok || !resolved.exists || !samePath(resolved.path, joined, guard.platform))
    return null
  return (await kindOf(resolved.path)) === 'dir' ? resolved.path : null
}

const OUTSIDE =
  'Its git folder is outside the granted folders or reached through a link, so the Git panel does not open it.'

/** Entries of a git directory that must not be links (git would follow them). */
const GIT_DIR_ENTRIES = ['HEAD', 'index', 'config', 'config.worktree', 'commondir', 'gitdir']
const COMMON_DIR_ENTRIES = ['objects', 'refs', 'packed-refs', 'config', 'info', 'logs', 'worktrees']

/**
 * Checks that `root` (a real folder inside the grants) is a repository the panel may
 * run git in, and returns where its git directory is.
 */
export async function checkRepo(guard: PathGuard, root: string): Promise<RepoCheck> {
  const P = guard.path
  const dotGit = P.join(root, '.git')
  const kind = await kindOf(dotGit)
  if (kind === 'missing')
    return { ok: false, reason: 'This folder is not a git repository.', notRepo: true }
  if (kind === 'link') return { ok: false, reason: 'Its .git is a link, which is not followed.' }

  let gitDir: string | null
  if (kind === 'dir') {
    gitDir = await pointerTarget(guard, root, '.git')
  } else if (kind === 'file') {
    // A worktree or submodule: `.git` is a file that says `gitdir: <path>`.
    const text = await readPointer(dotGit)
    const match = text ? /^gitdir: ?(.+?)\r?\n?$/.exec(text) : null
    const pointer = match?.[1]?.trim()
    gitDir = pointer ? await pointerTarget(guard, root, pointer) : null
  } else {
    return { ok: false, reason: 'Its .git is not a file or folder.' }
  }
  if (!gitDir) return { ok: false, reason: OUTSIDE }

  for (const name of GIT_DIR_ENTRIES) {
    if ((await kindOf(P.join(gitDir, name))) === 'link') return { ok: false, reason: OUTSIDE }
  }
  if ((await kindOf(P.join(gitDir, 'HEAD'))) !== 'file')
    return { ok: false, reason: 'This folder has a .git but is not a valid git repository.' }

  let commonDir = gitDir
  if ((await kindOf(P.join(gitDir, 'commondir'))) === 'file') {
    const text = await readPointer(P.join(gitDir, 'commondir'))
    const target = text ? await pointerTarget(guard, gitDir, text.trim()) : null
    if (!target) return { ok: false, reason: OUTSIDE }
    commonDir = target
  }
  for (const name of COMMON_DIR_ENTRIES) {
    if ((await kindOf(P.join(commonDir, name))) === 'link') return { ok: false, reason: OUTSIDE }
  }
  if ((await kindOf(P.join(commonDir, 'objects', 'info', 'alternates'))) !== 'missing')
    return {
      ok: false,
      reason:
        'This repository borrows objects from another folder (alternates), so the Git panel does not open it.',
    }
  return { ok: true, target: { root, gitDir } }
}

/** The repository's display entry for a checked folder. */
async function entryFor(
  guard: PathGuard,
  ref: GitRepoRef,
  path: string,
): Promise<GitRepoEntry | null> {
  const name = guard.path.basename(path) || path
  const check = await checkRepo(guard, path)
  if (check.ok) return { ...ref, name, path, kind: 'repo' }
  if (check.notRepo) return null
  return { ...ref, name, path, kind: 'refused', reason: check.reason }
}

/** Why a granted folder inside the repository at `outer` is not opened on its own. */
function enclosingReason(guard: PathGuard, outer: string): string {
  const P = guard.path
  if (guard.isRoot(outer) || guard.isRoot(P.dirname(outer)))
    return `This folder is part of the git repository at ${outer}, which is shown under its own granted folder.`
  if (guard.isWithinGrants(outer))
    return `This folder is part of the git repository at ${outer}. The Git panel opens a repository from a granted folder that is its top folder (or holds it directly); grant ${outer} to see it.`
  return `This folder is inside the git repository at ${outer}, which is not granted. Grant that folder to see its changes.`
}

/** The nearest folder above `root` that has a `.git`, or null. */
async function enclosingRepo(guard: PathGuard, root: string): Promise<string | null> {
  const P = guard.path
  for (let dir = P.dirname(root); ; dir = P.dirname(dir)) {
    if ((await kindOf(P.join(dir, '.git'))) !== 'missing') return dir
    if (P.dirname(dir) === dir) return null
  }
}

/**
 * The repositories in each granted folder: the folder itself when it is one, else the
 * repositories directly inside it. A granted folder inside a repository whose top
 * folder is not granted is listed as refused: git would read that repository's
 * settings and objects outside the grant.
 */
export async function discoverRepos(guard: PathGuard): Promise<GitFolder[]> {
  const P = guard.path
  return Promise.all(
    filesRoots(guard).map(async (folder): Promise<GitFolder> => {
      const result: GitFolder = {
        rootId: folder.id,
        name: folder.name,
        path: folder.path,
        repos: [],
      }
      const self = await entryFor(guard, { rootId: folder.id, rel: '' }, folder.path)
      if (self) {
        result.repos.push(self)
        return result
      }
      let names: string[] = []
      try {
        names = (await fs.readdir(folder.path)).sort().slice(0, MAX_CHILD_SCAN)
      } catch {
        // Unreadable: no repositories to show.
      }
      for (const name of names) {
        if (result.repos.length >= MAX_CHILD_REPOS) break
        if (name === '.git' || CONTROL_CHARS.test(name)) continue
        const path = P.join(folder.path, name)
        if (guard.blockedReason(path)) continue
        if ((await kindOf(path)) !== 'dir') continue
        if ((await kindOf(P.join(path, '.git'))) === 'missing') continue
        const where = await resolveLocation(guard, { rootId: folder.id, rel: name })
        if (!where.ok) continue
        const entry = await entryFor(guard, { rootId: folder.id, rel: name }, where.path)
        if (entry) result.repos.push(entry)
      }
      if (result.repos.length === 0) {
        const outer = await enclosingRepo(guard, folder.path)
        if (outer)
          result.repos.push({
            rootId: folder.id,
            rel: '',
            name: folder.name,
            path: folder.path,
            kind: 'refused',
            reason: enclosingReason(guard, outer),
          })
      }
      return result
    }),
  )
}

/**
 * Turns a repository named by the renderer into a checked target, against the CURRENT
 * grants. Only the shapes discoverRepos lists are accepted: a granted folder itself or
 * a folder directly inside it.
 */
export async function repoTarget(
  guard: PathGuard,
  ref: GitRepoRef,
): Promise<{ ok: true; target: GitTarget } | { ok: false; reason: string; gone?: true }> {
  if (ref.rel.includes('/'))
    return { ok: false, reason: 'That is not a repository the panel lists.' }
  const where = await resolveLocation(guard, ref)
  if (!where.ok) return { ok: false, reason: where.reason, gone: true }
  if (!where.exists || (await kindOf(where.path)) !== 'dir')
    return { ok: false, reason: 'That folder no longer exists.', gone: true }
  return checkRepo(guard, where.path)
}
