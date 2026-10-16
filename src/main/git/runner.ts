// Runs git for the Git panel. A repository in a granted folder may have been downloaded
// from anywhere, so everything it can configure is treated as hostile: git runs by
// absolute path with an argument array (never a shell), a fixed set of flags that turn
// off every repository setting that could start another program or reach the network,
// a minimal environment, a timeout and an output cap. See gitInvocation for the policy.
import type { Readable } from 'node:stream'
import {
  defaultKillTree,
  defaultSpawner,
  shellEnv,
  type ShellProcess,
  type ShellSpawner,
} from '../tools/run-shell'

/**
 * Settings that would let a repository run a program, reach the network or read a
 * file outside it during status, diff, log or config. Given with `-c`, so they win
 * over anything in the repository's own config.
 *
 * Filters (`filter.<name>.clean/smudge/process`) cannot be named in advance: the
 * repository's names are read first (with includes off, see repo-config.ts) and each
 * is disabled the same way, and a repository whose config includes other files is
 * refused, so that list is complete.
 */
export const NEUTRAL_CONFIG: readonly string[] = [
  // Status asks an fsmonitor hook (any program) which files changed.
  'core.fsmonitor=false',
  // No hook runs for these commands; point hooks at nothing anyway.
  'core.hooksPath=/dev/null',
  // External diff programs and pagers.
  'diff.external=',
  'core.pager=cat',
  // Credentials and prompts: nothing here needs them.
  'core.askPass=',
  'credential.helper=',
  // No transport at all: blocks lazy fetches in partial clones (remote helpers, ssh).
  'protocol.allow=never',
  // Signature checks run gpg.program.
  'log.showSignature=false',
  // Submodules would run git inside them with their own config.
  'submodule.recurse=false',
  'diff.ignoreSubmodules=all',
  'status.submoduleSummary=false',
  // Files the config may name (on Windows a \\server\share path leaks credentials).
  'core.excludesFile=/dev/null',
  'core.attributesFile=/dev/null',
  'diff.orderFile=/dev/null',
  'mailmap.file=/dev/null',
  'mailmap.blob=',
  'log.mailmap=false',
  // Nothing written to the repository, and output in a form we parse.
  'core.untrackedCache=false',
  'core.splitIndex=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'color.ui=false',
  'core.quotePath=false',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.relative=false',
]

/** Global flags before the subcommand. */
export const GLOBAL_FLAGS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '--literal-pathspecs',
  '--no-replace-objects',
]

/**
 * The environment git runs with: the shell tool's allow-list (no credentials, nothing
 * of the app's own) plus variables that stop prompts, ignore the system and user
 * config files, and keep status from writing the index.
 */
export function gitEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return {
    ...shellEnv(env, platform),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_ADVICE: '0',
    // English messages (exit reasons are matched); -z output does not depend on it.
    LC_ALL: 'C',
    LANGUAGE: 'C',
  }
}

/** The repository git is pointed at: no discovery, both paths already checked. */
export interface GitTarget {
  /** The working tree's top folder (a real path inside the grants). */
  root: string
  /** Its git directory (a real path inside the grants). */
  gitDir: string
}

/** Filter driver names whose programs must be disabled (from repo-config.ts). */
export type FilterNames = readonly string[]

/** The complete argument list for one git subcommand in `target`. */
export function gitInvocation(
  target: GitTarget,
  filters: FilterNames,
  subcommand: readonly string[],
): string[] {
  const config = [
    ...NEUTRAL_CONFIG,
    ...filters.flatMap((name) => [
      `filter.${name}.clean=`,
      `filter.${name}.smudge=`,
      `filter.${name}.process=`,
      `filter.${name}.required=false`,
    ]),
  ]
  return [
    ...GLOBAL_FLAGS,
    `--git-dir=${target.gitDir}`,
    `--work-tree=${target.root}`,
    ...config.flatMap((setting) => ['-c', setting]),
    ...subcommand,
  ]
}

export interface GitRunOptions {
  /** Most stdout bytes kept; past this git is stopped and `truncated` is set. */
  maxBytes: number
  timeoutMs?: number
}

export interface GitOutput {
  code: number | null
  stdout: Buffer
  stderr: string
  truncated: boolean
  timedOut: boolean
}

/** Runs git with exactly these arguments in `cwd`. */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
  options: GitRunOptions,
) => Promise<GitOutput>

export interface GitRunnerDeps {
  /** Absolute path of the git executable (from detect.ts). */
  git: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: ShellSpawner
}

const STDERR_MAX = 16_384
const DEFAULT_TIMEOUT = 15_000

/** A GitRunner that spawns the real git: no shell, minimal environment, killed on timeout or overflow. */
export function createGitRunner(deps: GitRunnerDeps): GitRunner {
  const platform = deps.platform ?? process.platform
  const env = gitEnv(deps.env ?? process.env, platform)
  const spawn = deps.spawn ?? defaultSpawner
  const killTree = defaultKillTree(platform, spawn, deps.env ?? process.env)
  return (args, cwd, options) =>
    new Promise<GitOutput>((resolve) => {
      let child: ShellProcess
      try {
        child = spawn(deps.git, args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: platform !== 'win32',
        })
      } catch (error) {
        resolve({
          code: null,
          stdout: Buffer.alloc(0),
          stderr: error instanceof Error ? error.message : String(error),
          truncated: false,
          timedOut: false,
        })
        return
      }
      const out: Buffer[] = []
      let outBytes = 0
      let err = ''
      let truncated = false
      let timedOut = false
      let done = false
      const stop = (): void => {
        void killTree(child).catch(() => undefined)
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, options.timeoutMs ?? DEFAULT_TIMEOUT)
      collect(child.stdout, (chunk) => {
        if (truncated) return
        const room = options.maxBytes - outBytes
        if (chunk.length > room) {
          out.push(chunk.subarray(0, Math.max(0, room)))
          outBytes = options.maxBytes
          truncated = true
          stop()
          return
        }
        out.push(chunk)
        outBytes += chunk.length
      })
      collect(child.stderr, (chunk) => {
        if (err.length < STDERR_MAX) err += chunk.toString('utf8').slice(0, STDERR_MAX - err.length)
      })
      const finish = (code: number | null, error?: Error): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({
          code,
          stdout: Buffer.concat(out),
          stderr: error ? error.message : err,
          truncated,
          timedOut,
        })
      }
      child.once('error', (error) => {
        finish(null, error)
      })
      child.once('close', (code) => {
        finish(code)
      })
    })
}

function collect(stream: Readable | null, onChunk: (chunk: Buffer) => void): void {
  stream?.on('data', (chunk: Buffer | string) => {
    onChunk(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  })
}
