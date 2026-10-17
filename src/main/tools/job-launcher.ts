// job-run.exe (native/job-run): runs a Windows command inside a Job Object that kills
// everything the command started once the command finishes or is stopped.
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { PathGuard } from '../permissions/guard'
import { isInside, samePath } from '../permissions/paths'

/**
 * The launcher's SHA-256, compiled in at build time from the build's pins file
 * (build/job-helper-pins.json, written by scripts/build-job-helper.mjs); undefined in a
 * build without the launcher and in tests.
 */
declare const __JOB_RUN_SHA256__: string | undefined

export const JOB_RUN_SHA256: string | null =
  typeof __JOB_RUN_SHA256__ === 'string' && /^[0-9a-f]{64}$/.test(__JOB_RUN_SHA256__)
    ? __JOB_RUN_SHA256__
    : null

/** Where the installer puts the launcher, relative to the app's resources folder. */
export const JOB_RUN_PATH = ['helpers', 'job-run.exe'] as const

/**
 * The launcher to run a command with, or why there is none. A null reason means a job is
 * not expected at all (not Windows), so there is nothing to tell the user.
 */
export type JobLauncher = { ok: true; path: string } | { ok: false; reason: string | null }

/** Finds and verifies the launcher; called immediately before every command is started. */
export type FindJobLauncher = () => Promise<JobLauncher>

export interface VerifyOptions {
  /** The installed app's resources folder, or null when not running from an install. */
  resources: string | null
  /** The compiled-in digest, or null in a build without the launcher. */
  sha256: string | null
  /** Granted folders: a launcher inside one could have been written by the agent. */
  grantedRoots: () => readonly string[]
  platform: NodeJS.Platform
}

/**
 * The launcher at resources\helpers\job-run.exe, only if it is a regular file (not a
 * link) whose real path is exactly that location, outside every granted folder, and
 * whose SHA-256 matches the compiled-in pin. It is never looked up on PATH.
 */
export async function verifyJobLauncher(options: VerifyOptions): Promise<JobLauncher> {
  const { resources, sha256, platform } = options
  if (!resources) return { ok: false, reason: 'job-run.exe is only bundled with the installed app' }
  if (!sha256) return { ok: false, reason: 'this build has no pinned job-run.exe' }
  const P = platform === 'win32' ? path.win32 : path.posix
  const expected = P.join(resources, ...JOB_RUN_PATH)
  let real: string
  let bytes: Buffer
  try {
    if (!(await fs.lstat(expected)).isFile()) {
      return { ok: false, reason: 'job-run.exe is not a regular file' }
    }
    real = await fs.realpath(expected)
    const realResources = await fs.realpath(resources)
    if (!samePath(real, P.join(realResources, ...JOB_RUN_PATH), platform)) {
      return { ok: false, reason: "job-run.exe resolves outside the app's resources folder" }
    }
    bytes = await fs.readFile(real)
  } catch {
    return { ok: false, reason: 'job-run.exe is missing or unreadable' }
  }
  if (options.grantedRoots().some((root) => isInside(real, root, platform))) {
    return { ok: false, reason: 'job-run.exe is inside a granted folder' }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    return { ok: false, reason: 'job-run.exe failed its integrity check' }
  }
  return { ok: true, path: real }
}

/** The installed app's resources folder (it holds app.asar), or null in development. */
function installedResources(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  return resources && existsSync(path.join(resources, 'app.asar')) ? resources : null
}

/** The launcher run_shell uses by default: the installed, pinned one, on Windows only. */
export function defaultJobLauncher(platform: NodeJS.Platform, guard: PathGuard): FindJobLauncher {
  const reported = new Set<string>()
  return async () => {
    if (platform !== 'win32') return { ok: false, reason: null }
    const launcher = await verifyJobLauncher({
      resources: installedResources(),
      sha256: JOB_RUN_SHA256,
      grantedRoots: () => guard.grantedRoots(),
      platform,
    })
    if (!launcher.ok && launcher.reason && !reported.has(launcher.reason)) {
      reported.add(launcher.reason)
      console.warn(`run_shell: not using a Job Object: ${launcher.reason}`)
    }
    return launcher
  }
}

/**
 * The program and arguments that run `file args` inside a job: job-run.exe watches
 * `parentPid` (the app) and kills the job if it goes away.
 */
export function jobRunInvocation(
  launcher: string,
  parentPid: number,
  file: string,
  args: readonly string[],
): { file: string; args: string[] } {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new Error(`invalid parent pid ${String(parentPid)}`)
  }
  return { file: launcher, args: ['--parent', String(parentPid), '--', file, ...args] }
}

/** What job-run.exe reported on its report channel (fd 3). */
export type JobReport =
  | { kind: 'exit'; code: number; background: number | null }
  | { kind: 'error'; step: string; code: number }

const REPORT_EXIT = /^job-run:1 exit=(\d{1,10}) background=(-1|\d{1,10})\n$/
const REPORT_ERROR = /^job-run:1 error=([A-Za-z()]{1,40}) code=(\d{1,10})\n$/

/** Parses the single line job-run.exe writes to fd 3; null for anything else. */
export function parseJobReport(text: string): JobReport | null {
  const exit = REPORT_EXIT.exec(text)
  if (exit) {
    const background = Number(exit[2])
    return { kind: 'exit', code: Number(exit[1]), background: background < 0 ? null : background }
  }
  const error = REPORT_ERROR.exec(text)
  return error ? { kind: 'error', step: error[1] ?? '', code: Number(error[2]) } : null
}

/** The sentence a result gets for the background processes the job stopped. */
export function backgroundNote(count: number | null): string | null {
  if (count === null) {
    return 'Any background processes the command left running were stopped when it finished.'
  }
  if (count === 0) return null
  return count === 1
    ? '1 background process was stopped when the command finished.'
    : `${String(count)} background processes were stopped when the command finished.`
}
