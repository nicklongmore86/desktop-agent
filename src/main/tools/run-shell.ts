import { spawn as nodeSpawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { Readable } from 'node:stream'
import { redactSecrets } from '../permissions/audit'
import { ToolFailure, ToolInputError, errorResult, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
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

export type KillTree = (process: ShellProcess) => void

export const defaultSpawner: ShellSpawner = (file, args, options) => nodeSpawn(file, args, options)

/** The exact program and arguments a command runs with on `platform`. */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform,
): { file: string; args: string[] } {
  return platform === 'win32'
    ? { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
    : { file: '/bin/sh', args: ['-c', command] }
}

/**
 * Kills a shell and everything it started: `taskkill /T /F` on Windows, a
 * SIGKILL to the process group elsewhere (the shell is its group leader).
 */
export function defaultKillTree(
  platform: NodeJS.Platform,
  spawn: ShellSpawner,
  cwd: () => string,
): KillTree {
  return (child) => {
    const pid = child.pid
    if (pid === undefined) return
    if (platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        cwd: cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      })
      killer.once('error', () => child.kill('SIGKILL'))
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/** process.env without the app's own variables, which commands have no business seeing. */
export function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(ANTHROPIC_|ELECTRON_)/i.test(key)),
  )
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

  text(): string {
    const dropped = this.total - this.headBytes - this.tailBytes
    const head = Buffer.concat(this.head).toString('utf8')
    const tail = Buffer.concat(this.tail).toString('utf8')
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
    summarize: (input) => ({
      command: redactSecrets(input.command),
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    }),
    async run(input, call) {
      const { path: cwd, exists } = await call.resolve(input.cwd)
      if (!exists || !(await fs.stat(cwd)).isDirectory())
        throw new ToolFailure(`Not a folder: ${cwd}`)

      const { file, args } = shellInvocation(input.command, platform)
      const detail = `cwd: ${cwd}\nshell: ${[file, ...args.slice(0, -1)].join(' ')}\n\n${input.command}`
      const approved = await call.approve({
        kind: 'shell',
        summary: `Run a command in ${cwd}`,
        detail,
      })
      if (!approved) {
        return errorResult('The user declined to run the command. Nothing was run.')
      }

      return runProcess(file, args, cwd, input.timeoutMs, call.ctx.signal, deps)
    },
  }
}

const KILL_GRACE_MS = 5000

async function runProcess(
  file: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  deps: ResolvedDeps,
): Promise<{ content: string; isError?: boolean }> {
  const stdout = new OutputCollector(deps.limits.maxShellOutputBytes)
  const stderr = new OutputCollector(deps.limits.maxShellOutputBytes)
  let child: ShellProcess
  try {
    child = deps.spawn(file, args, {
      cwd,
      env: deps.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: deps.platform !== 'win32',
    })
  } catch (error) {
    return errorResult(`Could not start ${file}: ${(error as Error).message}`)
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk)
  })

  const state: { stoppedBy: 'timeout' | 'cancel' | null } = { stoppedBy: null }
  const outcome = await new Promise<
    | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
    | { kind: 'error'; error: Error }
    | { kind: 'unresponsive' }
  >((resolve) => {
    let graceTimer: NodeJS.Timeout | undefined
    const stop = (reason: 'timeout' | 'cancel'): void => {
      if (state.stoppedBy) return
      state.stoppedBy = reason
      deps.killTree(child)
      graceTimer = setTimeout(() => {
        resolve({ kind: 'unresponsive' })
      }, KILL_GRACE_MS)
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

  const streams = `--- stdout ---\n${stdout.text()}\n--- stderr ---\n${stderr.text()}`
  if (outcome.kind === 'error') {
    return errorResult(`Could not run ${file}: ${outcome.error.message}`)
  }
  if (state.stoppedBy === 'timeout') {
    return errorResult(
      `Timed out after ${String(timeoutMs / 1000)} s; the process was killed.\n${streams}`,
    )
  }
  if (state.stoppedBy === 'cancel')
    return errorResult(`Cancelled; the process was killed.\n${streams}`)
  if (outcome.kind === 'unresponsive') return errorResult(`The process did not exit.\n${streams}`)
  const status =
    outcome.code !== null
      ? `exit code: ${String(outcome.code)}`
      : `killed by signal ${outcome.signal ?? 'unknown'}`
  return { content: `${status}\ncwd: ${cwd}\n${streams}` }
}
