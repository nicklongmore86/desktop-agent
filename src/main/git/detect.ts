// Finds an installed git. Nothing is bundled: when git is missing the panel says so
// and offers the Git for Windows download page. Only absolute paths are considered,
// in the standard install folders first and then PATH, and never a git inside a
// granted folder or a relative PATH entry (a downloaded folder could plant one). A
// candidate is resolved to its real path first (symbolic links, junctions), checked
// again there, and that real path is what runs.
import { promises as fs } from 'node:fs'
import { checkPathSyntax, isInside, pathApi } from '../permissions/paths'
import type { GitRunner } from './runner'

/** The oldest git with everything the runner relies on (GIT_CONFIG_GLOBAL is 2.32). */
export const MIN_GIT: readonly [number, number] = [2, 32]

export interface DetectDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** The granted folders: a git inside one is never used. */
  grantedRoots: () => readonly string[]
  /** True when `path` (already a real path) is a regular file. */
  isFile?: (path: string) => Promise<boolean>
  /** Like fs.promises.realpath: links and junctions resolved; rejects when it cannot. */
  realpath?: (path: string) => Promise<string>
}

const nodeIsFile = async (path: string): Promise<boolean> => {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

/** Every place a git executable is looked for, in order. Pure: exported for tests. */
export function gitCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const P = pathApi(platform)
  const absolute = (dir: string | undefined): dir is string =>
    Boolean(dir) && checkPathSyntax(dir as string, platform) === null
  const candidates: string[] = []
  if (platform === 'win32') {
    const get = (name: string): string | undefined =>
      Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    for (const base of [
      get('ProgramW6432'),
      get('ProgramFiles'),
      get('ProgramFiles(x86)'),
      'C:\\Program Files',
    ]) {
      if (!absolute(base)) continue
      candidates.push(P.join(base, 'Git', 'cmd', 'git.exe'), P.join(base, 'Git', 'bin', 'git.exe'))
    }
    const local = get('LOCALAPPDATA')
    if (absolute(local))
      candidates.push(
        P.join(local, 'Programs', 'Git', 'cmd', 'git.exe'),
        P.join(local, 'Programs', 'Git', 'bin', 'git.exe'),
      )
    for (const dir of (get('PATH') ?? '').split(';')) {
      const trimmed = dir.trim().replace(/^"(.*)"$/, '$1')
      if (absolute(trimmed)) candidates.push(P.join(trimmed, 'git.exe'))
    }
  } else {
    candidates.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git')
    for (const dir of (env['PATH'] ?? '').split(':')) {
      if (absolute(dir)) candidates.push(P.join(dir, 'git'))
    }
  }
  return [...new Set(candidates)]
}

/**
 * The real path of the first candidate that exists and is outside the granted folders,
 * or null. A candidate reached through a link or junction is judged (and run) by where
 * it really is; one that cannot be resolved is skipped.
 */
export async function findGit(deps: DetectDeps): Promise<string | null> {
  const isFile = deps.isFile ?? nodeIsFile
  const realpath = deps.realpath ?? ((path: string) => fs.realpath(path))
  const { platform } = deps
  const roots = deps.grantedRoots()
  // Granted folders are stored as real paths; resolve them again in case one changed.
  const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)))
  const inGrant = (path: string): boolean =>
    [...roots, ...realRoots].some((root) => isInside(path, root, platform))
  for (const candidate of gitCandidates(platform, deps.env)) {
    if (inGrant(candidate)) continue
    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      continue
    }
    if (checkPathSyntax(real, platform) !== null || inGrant(real)) continue
    if (await isFile(real)) return real
  }
  return null
}

/** `git version 2.45.1.windows.1` -> [2, 45], or null. */
export function parseGitVersion(
  output: string,
): { text: string; major: number; minor: number } | null {
  const match = /^git version (\d+)\.(\d+)[^\s]*/.exec(output.trim())
  if (!match) return null
  return {
    text: match[0].slice('git version '.length),
    major: Number(match[1]),
    minor: Number(match[2]),
  }
}

export type Detected = { ok: true; git: string; version: string } | { ok: false; detail?: string }

/** Finds git and checks its version by running `git --version` (outside any repository). */
export async function detectGit(
  deps: DetectDeps & { runner: (git: string) => GitRunner; cwd: string },
): Promise<Detected> {
  const git = await findGit(deps)
  if (!git) return { ok: false }
  const result = await deps.runner(git)(['--version'], deps.cwd, {
    maxBytes: 4096,
    timeoutMs: 10_000,
  })
  const version = result.code === 0 ? parseGitVersion(result.stdout.toString('utf8')) : null
  if (!version) return { ok: false, detail: `${git} did not run as git.` }
  const [major, minor] = MIN_GIT
  if (version.major < major || (version.major === major && version.minor < minor))
    return {
      ok: false,
      detail: `Git ${version.text} is too old. The Git panel needs Git ${String(major)}.${String(minor)} or later.`,
    }
  return { ok: true, git, version: version.text }
}
