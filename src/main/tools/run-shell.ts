import { spawn as nodeSpawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { Readable } from 'node:stream'
import { redactSecrets } from '../permissions/audit'
import { ToolFailure, ToolInputError, errorResult, type RunResult, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { sameIdentity, type Identity } from './safe-fs'
import { decodeCliXml, encodePowerShell, powerShellScript, treeKillScript } from './shell-windows'
import { formatBytes } from './text'

/** The parts of a ChildProcess the shell tool uses. */
export interface ShellProcess {
  readonly pid?: number | undefined
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface ShellSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ['ignore', 'pipe', 'pipe']
  windowsHide: true
  /** POSIX: start a new process group so the whole tree can be killed. */
  detached: boolean
}

export type ShellSpawner = (
  file: string,
  args: readonly string[],
  options: ShellSpawnOptions,
) => ShellProcess

/** The outcome of killing a process tree: whether the killer reports success. */
export type KillResult = { ok: true } | { ok: false; reason: string }

export type KillTree = (process: ShellProcess) => Promise<KillResult>

export const defaultSpawner: ShellSpawner = (file, args, options) => nodeSpawn(file, args, options)

const WINDOWS_ROOT_PATTERN = /^[A-Za-z]:\\[^<>:"/\\|?*\0]+(\\[^<>:"/\\|?*\0]+)*$/

/**
 * The Windows directory, from %SystemRoot% when it is a plain absolute local
 * path, else C:\Windows. Programs are started from here by absolute path so
 * that a powershell.exe or taskkill.exe planted in the working folder or on
 * PATH is never picked up.
 */
export function windowsRoot(env: NodeJS.ProcessEnv): string {
  const candidate = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir'] ?? ''
  return WINDOWS_ROOT_PATTERN.test(candidate) ? candidate.replace(/\\+$/, '') : 'C:\\Windows'
}

/** Flags before the encoded script. Its stderr comes back as CLIXML; see decodeCliXml. */
const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand']

function powerShellPath(root: string): string {
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * The exact program (an absolute path) and arguments a command runs with on `platform`.
 * On Windows the command goes in as `-EncodedCommand` (see shell-windows.ts), after a
 * fixed preamble that makes output UTF-8, so what runs is exactly what was approved.
 */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } {
  return platform === 'win32'
    ? {
        file: powerShellPath(windowsRoot(env)),
        args: [...POWERSHELL_FLAGS, encodePowerShell(powerShellScript(command))],
      }
    : { file: '/bin/sh', args: ['-c', command] }
}

/**
 * Kills a shell and everything it started: `taskkill /T /F` on Windows (by absolute
 * path, with a minimal environment, and checking its exit code), falling back to a
 * PowerShell walk of the process tree if taskkill cannot start or fails; a SIGKILL to
 * the process group elsewhere (the shell is its group leader). Without a Job Object, a
 * Windows grandchild whose parent already exited can escape both; the result says so
 * rather than claiming success.
 */
export function defaultKillTree(
  platform: NodeJS.Platform,
  spawn: ShellSpawner,
  env: NodeJS.ProcessEnv,
): KillTree {
  return async (child) => {
    const pid = child.pid
    if (pid === undefined) return { ok: false, reason: 'the process has no id' }
    if (platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL')
        return { ok: true }
      } catch (groupError) {
        return child.kill('SIGKILL')
          ? { ok: true }
          : { ok: false, reason: `could not signal the process group (${String(groupError)})` }
      }
    }
    const root = windowsRoot(env)
    const taskkill = await runKiller(spawn, root, 'taskkill', `${root}\\System32\\taskkill.exe`, [
      '/PID',
      String(pid),
      '/T',
      '/F',
    ])
    if (taskkill.ok) return taskkill
    const fallback = await runKiller(spawn, root, 'the PowerShell fallback', powerShellPath(root), [
      ...POWERSHELL_FLAGS,
      encodePowerShell(treeKillScript(pid)),
    ])
    // The shell itself, in case both killers failed to reach it.
    child.kill('SIGKILL')
    return fallback.ok ? fallback : { ok: false, reason: `${taskkill.reason}; ${fallback.reason}` }
  }
}

/** Runs a Windows kill helper from System32 with a minimal environment; ok if it exits 0. */
function runKiller(
  spawn: ShellSpawner,
  root: string,
  name: string,
  file: string,
  args: readonly string[],
): Promise<KillResult> {
  return new Promise<KillResult>((resolve) => {
    let killer: ShellProcess
    try {
      killer = spawn(file, args, {
        cwd: `${root}\\System32`,
        env: { SystemRoot: root, windir: root },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      })
    } catch (error) {
      resolve({ ok: false, reason: `${name} could not start: ${(error as Error).message}` })
      return
    }
    killer.stdout?.resume()
    killer.stderr?.resume()
    killer.once('error', (error) => {
      resolve({ ok: false, reason: `${name} could not start: ${error.message}` })
    })
    killer.once('close', (code) => {
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, reason: `${name} exited with code ${String(code)}` },
      )
    })
  })
}

/** Variables a command may see; everything else in the app's environment is withheld. */
const ENV_ALLOWLIST = new Set([
  // Both platforms
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  // POSIX
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  // Windows
  'SystemRoot',
  'windir',
  'SystemDrive',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'PSModulePath',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
])
const ENV_ALLOWLIST_UPPER = new Set([...ENV_ALLOWLIST].map((name) => name.toUpperCase()))

/** Never passed on, even if allowlisted: credentials and the app's own variables. */
const ENV_DENIED = /API_KEY|TOKEN|^ANTHROPIC_|^OPENAI_|^CODEX_|^CLAUDE_|^ELECTRON_/i

/**
 * The environment a command runs with: only allowlisted variables (plus LC_*), never
 * anything that looks like a credential or belongs to the app. Names match
 * case-insensitively on Windows, where the environment is case-insensitive, keeping
 * the first of any names that differ only in case.
 */
export function shellEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const windows = platform === 'win32'
  const result: NodeJS.ProcessEnv = {}
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || ENV_DENIED.test(name)) continue
    const allowed = windows
      ? ENV_ALLOWLIST_UPPER.has(name.toUpperCase()) || /^LC_/i.test(name)
      : ENV_ALLOWLIST.has(name) || name.startsWith('LC_')
    if (!allowed) continue
    const key = windows ? name.toUpperCase() : name
    if (seen.has(key)) continue
    seen.add(key)
    result[name] = value
  }
  return result
}

/** Keeps the first and last `limit / 2` bytes of a stream and counts what it drops. */
class OutputCollector {
  private head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  private total = 0

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length
    const headRoom = Math.ceil(this.limit / 2) - this.headBytes
    if (headRoom > 0) {
      const part = chunk.subarray(0, headRoom)
      this.head.push(part)
      this.headBytes += part.length
      chunk = chunk.subarray(part.length)
    }
    if (chunk.length === 0) return
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    const tailLimit = Math.floor(this.limit / 2)
    while (this.tailBytes > tailLimit && this.tail.length > 0) {
      const first = this.tail[0] ?? Buffer.alloc(0)
      const excess = this.tailBytes - tailLimit
      if (first.length <= excess) {
        this.tail.shift()
        this.tailBytes -= first.length
      } else {
        this.tail[0] = first.subarray(excess)
        this.tailBytes -= excess
      }
    }
  }

  /** The kept text; `decode` is applied to the start and the end separately. */
  text(decode: (text: string) => string = (text) => text): string {
    const dropped = this.total - this.headBytes - this.tailBytes
    const head = decode(Buffer.concat(this.head).toString('utf8'))
    const tail = decode(Buffer.concat(this.tail).toString('utf8'))
    return dropped > 0 ? `${head}\n… [${formatBytes(dropped)} omitted] …\n${tail}` : head + tail
  }
}

interface Input {
  command: string
  cwd: string
  timeoutMs: number
}

const MAX_COMMAND_LENGTH = 8000

export function runShellTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { limits, platform } = deps
  const shellName = platform === 'win32' ? 'Windows PowerShell' : '/bin/sh'
  return {
    name: 'run_shell',
    description:
      `Run a command with ${shellName} in a folder inside the granted folders. The user sees the ` +
      'exact command and folder and must approve every run. No input is available (non-interactive). ' +
      `Default timeout ${String(limits.defaultShellTimeoutMs / 1000)} s (max ` +
      `${String(limits.maxShellTimeoutMs / 1000)} s). Returns the exit code, stdout and stderr; ` +
      `output over ${formatBytes(limits.maxShellOutputBytes)} per stream is cut in the middle.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Absolute path of the folder to run it in.' },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: limits.maxShellTimeoutMs,
          description: 'Kill the command after this many milliseconds.',
        },
      },
      required: ['command', 'cwd'],
      additionalProperties: false,
    },
    needsApproval: true,
    parse(input) {
      const command = input.string('command')
      if (command.trim() === '') throw new ToolInputError('"command" is empty.')
      if (command.length > MAX_COMMAND_LENGTH) {
        throw new ToolInputError(
          `"command" is longer than ${String(MAX_COMMAND_LENGTH)} characters.`,
        )
      }
      return {
        command,
        cwd: input.string('cwd'),
        timeoutMs:
          input.optionalInteger('timeoutMs', 1000, limits.maxShellTimeoutMs) ??
          limits.defaultShellTimeoutMs,
      }
    },
    // The exact command is logged only once the user approved running it: it is then the
    // user's own action and the core of the audit trail. Unapproved commands are model
    // output that never ran, so only their shape is kept.
    summarize: (input, approval) =>
      approval === 'approved'
        ? { command: redactSecrets(input.command), cwd: input.cwd, timeoutMs: input.timeoutMs }
        : { commandLength: input.command.length, cwd: input.cwd, timeoutMs: input.timeoutMs },
    async run(input, call) {
      const { path: cwd, exists } = await call.resolve(input.cwd)
      const before = exists ? await folderIdentity(cwd) : null
      if (!before) throw new ToolFailure(`Not a folder: ${cwd}`, 'not-a-folder')

      const { file, args } = shellInvocation(input.command, platform, deps.env)
      const detail = `cwd: ${cwd}\nshell: ${[file, ...args.slice(0, -1)].join(' ')}\n\n${input.command}`
      const approved = await call.approve({
        kind: 'shell',
        summary: `Run a command in ${cwd}`,
        detail,
      })
      if (!approved) {
        return errorResult('The user declined to run the command. Nothing was run.', 'declined')
      }

      // Immediately before spawning: the folder must still be granted, resolve to the same
      // path and be the same folder (not swapped for another) as the one the user approved.
      const again = await call.resolve(input.cwd)
      const after = again.exists ? await folderIdentity(again.path) : null
      if (again.path !== cwd || !after || !sameIdentity(after, before)) {
        throw new ToolFailure(
          `${cwd} changed after the command was approved; nothing was run.`,
          'changed',
        )
      }
      call.throwIfAborted()

      return runProcess(file, args, cwd, input.timeoutMs, call.ctx.signal, deps)
    },
  }
}

/** Device and inode of a real (non-link) folder, or null. */
async function folderIdentity(path: string): Promise<Identity | null> {
  try {
    const stats = await fs.lstat(path, { bigint: true })
    return stats.isDirectory() && !stats.isSymbolicLink()
      ? { dev: stats.dev, ino: stats.ino }
      : null
  } catch {
    return null
  }
}

async function runProcess(
  file: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  deps: ResolvedDeps,
): Promise<RunResult> {
  const stdout = new OutputCollector(deps.limits.maxShellOutputBytes)
  const stderr = new OutputCollector(deps.limits.maxShellOutputBytes)
  let child: ShellProcess
  try {
    child = deps.spawn(file, args, {
      cwd,
      // Filtered again here so platform-specific matching applies whatever deps.env holds.
      env: shellEnv(deps.env, deps.platform),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: deps.platform !== 'win32',
    })
  } catch (error) {
    return errorResult(`Could not start ${file}: ${(error as Error).message}`, 'spawn-failed')
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk)
  })

  const graceMs = deps.limits.killGraceMs
  const state: { stoppedBy: 'timeout' | 'cancel' | null; kill: Promise<KillResult> | null } = {
    stoppedBy: null,
    kill: null,
  }
  const outcome = await new Promise<
    | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
    | { kind: 'error'; error: Error }
    | { kind: 'unresponsive' }
  >((resolve) => {
    let graceTimer: NodeJS.Timeout | undefined
    const stop = (reason: 'timeout' | 'cancel'): void => {
      if (state.stoppedBy) return
      state.stoppedBy = reason
      state.kill = deps.killTree(child).catch((error: unknown) => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }))
      graceTimer = setTimeout(() => {
        resolve({ kind: 'unresponsive' })
      }, graceMs)
    }
    const timer = setTimeout(() => {
      stop('timeout')
    }, timeoutMs)
    const onAbort = (): void => {
      stop('cancel')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const finish = (): void => {
      clearTimeout(timer)
      clearTimeout(graceTimer)
      signal.removeEventListener('abort', onAbort)
    }
    child.once('error', (error) => {
      finish()
      resolve({ kind: 'error', error })
    })
    child.once('close', (code, exitSignal) => {
      finish()
      resolve({ kind: 'exit', code, signal: exitSignal })
    })
    if (signal.aborted) onAbort()
  })

  // Windows PowerShell writes stderr as CLIXML when given an encoded command.
  const stderrText = stderr.text(deps.platform === 'win32' ? decodeCliXml : undefined)
  const streams = `--- stdout ---\n${stdout.text()}\n--- stderr ---\n${stderrText}`
  if (outcome.kind === 'error' && !state.stoppedBy) {
    return errorResult(`Could not run ${file}: ${outcome.error.message}`, 'spawn-failed')
  }
  if (!state.stoppedBy || !state.kill) {
    const status =
      outcome.kind === 'exit' && outcome.code !== null
        ? `exit code: ${String(outcome.code)}`
        : `killed by signal ${outcome.kind === 'exit' ? (outcome.signal ?? 'unknown') : 'unknown'}`
    return { content: `${status}\ncwd: ${cwd}\n${streams}` }
  }

  // Report the kill honestly: only claim the tree is gone if the killer said so and the
  // shell actually exited.
  const killed = await Promise.race([
    state.kill,
    new Promise<KillResult>((resolve) =>
      setTimeout(() => {
        resolve({ ok: false, reason: 'the kill command did not finish' })
      }, graceMs),
    ),
  ])
  const what =
    state.stoppedBy === 'timeout' ? `Timed out after ${String(timeoutMs / 1000)} s` : 'Cancelled'
  if (killed.ok && outcome.kind !== 'unresponsive') {
    return errorResult(
      `${what}; the process tree was killed.\n${streams}`,
      state.stoppedBy === 'timeout' ? 'timeout' : 'cancelled',
    )
  }
  const reason = !killed.ok
    ? killed.reason
    : `the shell did not exit within ${String(graceMs / 1000)} s of being killed`
  return errorResult(
    `${what}. The process tree may still be running: ${reason}.\n${streams}`,
    'kill-failed',
  )
}
