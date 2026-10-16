// Finds an installed git. Nothing is bundled: when git is missing the panel says so
// and offers the Git for Windows download page. Only absolute paths are considered,
// in the standard install folders first and then PATH, and never a git inside a
// granted folder or a relative PATH entry (a downloaded folder could plant one).
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
  /** True when `path` is a regular file (follows links, like running it would). */
  isFile?: (path: string) => Promise<boolean>
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
      if (absolute(base)) candidates.push(P.join(base, 'Git', 'cmd', 'git.exe'))
    }
    const local = get('LOCALAPPDATA')
    if (absolute(local)) candidates.push(P.join(local, 'Programs', 'Git', 'cmd', 'git.exe'))
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

/** The first candidate that exists and is outside the granted folders, or null. */
export async function findGit(deps: DetectDeps): Promise<string | null> {
  const isFile = deps.isFile ?? nodeIsFile
  const roots = deps.grantedRoots()
  for (const candidate of gitCandidates(deps.platform, deps.env)) {
    if (roots.some((root) => isInside(candidate, root, deps.platform))) continue
    if (await isFile(candidate)) return candidate
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
