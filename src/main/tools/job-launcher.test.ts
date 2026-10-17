import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext, makeSandbox, type Sandbox } from '../permissions/test-support'
import {
  backgroundNote,
  type JobLauncher,
  jobRunInvocation,
  JOB_RUN_SHA256,
  parseJobReport,
  verifyJobLauncher,
} from './job-launcher'
import {
  shellInvocation,
  shellLaunch,
  type ShellProcess,
  type ShellSpawnOptions,
  type ShellSpawner,
} from './run-shell'
import { toolHarness } from './test-support'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

let sb: Sandbox

beforeEach(async () => {
  sb = await makeSandbox()
})

afterEach(async () => {
  await sb.cleanup()
})

describe('jobRunInvocation', () => {
  it('runs the program by absolute path after --, watching the parent', () => {
    expect(
      jobRunInvocation('C:\\App\\resources\\helpers\\job-run.exe', 4321, 'C:\\ps.exe', [
        '-NoProfile',
        'AAAA',
      ]),
    ).toEqual({
      file: 'C:\\App\\resources\\helpers\\job-run.exe',
      args: ['--parent', '4321', '--', 'C:\\ps.exe', '-NoProfile', 'AAAA'],
    })
  })

  it('only accepts a real parent pid', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(() => jobRunInvocation('C:\\job-run.exe', pid, 'C:\\ps.exe', [])).toThrow(/pid/)
    }
  })
})

describe('shellLaunch', () => {
  const { file, args } = shellInvocation('Write-Output hi', 'win32', {
    SystemRoot: 'C:\\Windows',
  })

  it('wraps the exact PowerShell invocation in a verified launcher', () => {
    const launch = shellLaunch(file, args, { ok: true, path: 'C:\\R\\helpers\\job-run.exe' }, 77)
    expect(launch).toEqual({
      file: 'C:\\R\\helpers\\job-run.exe',
      args: ['--parent', '77', '--', file, ...args],
      job: true,
    })
    expect(launch.note).toBeUndefined()
  })

  it('falls back to the plain shell, saying why, when there is no verified launcher', () => {
    expect(
      shellLaunch(file, args, { ok: false, reason: 'job-run.exe failed its integrity check' }, 77),
    ).toEqual({
      file,
      args,
      job: false,
      note: 'Not run in a Job Object (job-run.exe failed its integrity check); processes the command started may still be running.',
    })
  })

  it('says nothing when no job was expected (not Windows)', () => {
    expect(shellLaunch('/bin/sh', ['-c', 'x'], { ok: false, reason: null }, 77)).toEqual({
      file: '/bin/sh',
      args: ['-c', 'x'],
      job: false,
    })
  })
})

describe('parseJobReport', () => {
  it('reads the exit code and the background count', () => {
    expect(parseJobReport('job-run:1 exit=7 background=2\n')).toEqual({
      kind: 'exit',
      code: 7,
      background: 2,
    })
    expect(parseJobReport('job-run:1 exit=4294967295 background=-1\n')).toEqual({
      kind: 'exit',
      code: 4294967295,
      background: null,
    })
  })

  it('reads a failure before the program ran', () => {
    expect(parseJobReport('job-run:1 error=AssignProcessToJobObject code=5\n')).toEqual({
      kind: 'error',
      step: 'AssignProcessToJobObject',
      code: 5,
    })
  })

  it('accepts exactly one well-formed line and nothing else', () => {
    for (const text of [
      '',
      'job-run:1 exit=0 background=0',
      'job-run:1 exit=0 background=0\njob-run:1 exit=0 background=9\n',
      'x job-run:1 exit=0 background=0\n',
      'job-run:2 exit=0 background=0\n',
      'job-run:1 exit=-3 background=0\n',
      'job-run:1 error=a b code=5\n',
    ]) {
      expect(parseJobReport(text)).toBeNull()
    }
  })
})

describe('backgroundNote', () => {
  it('counts what was stopped, and says nothing when nothing was', () => {
    expect(backgroundNote(0)).toBeNull()
    expect(backgroundNote(1)).toBe('1 background process was stopped when the command finished.')
    expect(backgroundNote(2)).toBe('2 background processes were stopped when the command finished.')
    expect(backgroundNote(null)).toMatch(/were stopped when it finished/)
  })
})

describe('verifyJobLauncher', () => {
  const content = Buffer.from('MZ pretend launcher')
  const pin = sha(content)
  let resources: string

  beforeEach(async () => {
    resources = path.join(sb.base, 'resources')
    await fs.mkdir(path.join(resources, 'helpers'), { recursive: true })
    await fs.writeFile(path.join(resources, 'helpers', 'job-run.exe'), content)
  })

  const verify = (overrides: Partial<Parameters<typeof verifyJobLauncher>[0]> = {}) =>
    verifyJobLauncher({
      resources,
      sha256: pin,
      grantedRoots: () => [sb.root],
      platform: process.platform,
      ...overrides,
    })

  it('accepts the pinned launcher at resources/helpers/job-run.exe, by its real path', async () => {
    expect(await verify()).toEqual({
      ok: true,
      path: await fs.realpath(path.join(resources, 'helpers', 'job-run.exe')),
    })
  })

  it('has no compiled-in pin outside a Windows build', () => {
    expect(JOB_RUN_SHA256).toBeNull()
  })

  it('refuses a launcher that differs from the pin', async () => {
    await fs.appendFile(path.join(resources, 'helpers', 'job-run.exe'), 'x')
    expect(await verify()).toEqual({
      ok: false,
      reason: 'job-run.exe failed its integrity check',
    })
  })

  it('refuses when there is no launcher, no install or no pin', async () => {
    expect(await verify({ resources: null })).toEqual({
      ok: false,
      reason: 'job-run.exe is only bundled with the installed app',
    })
    expect(await verify({ sha256: null })).toEqual({
      ok: false,
      reason: 'this build has no pinned job-run.exe',
    })
    await fs.rm(path.join(resources, 'helpers', 'job-run.exe'))
    expect(await verify()).toEqual({ ok: false, reason: 'job-run.exe is missing or unreadable' })
  })

  it('refuses a launcher inside a granted folder', async () => {
    expect(await verify({ grantedRoots: () => [resources] })).toEqual({
      ok: false,
      reason: 'job-run.exe is inside a granted folder',
    })
  })

  // Creating symlinks on Windows needs a privilege the CI runner may not have.
  it.skipIf(process.platform === 'win32')(
    'refuses a link, and a launcher reached through one',
    async () => {
      const elsewhere = path.join(sb.root, 'job-run.exe')
      await fs.writeFile(elsewhere, content)
      const launcher = path.join(resources, 'helpers', 'job-run.exe')
      await fs.rm(launcher)
      await fs.symlink(elsewhere, launcher)
      expect(await verify({ grantedRoots: () => [] })).toEqual({
        ok: false,
        reason: 'job-run.exe is not a regular file',
      })
      await fs.rm(path.join(resources, 'helpers'), { recursive: true })
      await fs.symlink(sb.root, path.join(resources, 'helpers'))
      expect(await verify({ grantedRoots: () => [] })).toEqual({
        ok: false,
        reason: "job-run.exe resolves outside the app's resources folder",
      })
    },
  )
})

class FakeJobProcess extends EventEmitter implements ShellProcess {
  readonly pid = 4343
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly report = new PassThrough()
  readonly stdio = [null, this.stdout, this.stderr, this.report]
  readonly kill = vi.fn(() => {
    this.exit(null, 'SIGKILL')
    return true
  })

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end()
    this.stderr.end()
    this.report.end()
    setImmediate(() => this.emit('close', code, signal))
  }
}

function fakeJobSpawner(script: (child: FakeJobProcess) => void) {
  const calls: { file: string; args: readonly string[]; options: ShellSpawnOptions }[] = []
  const spawn: ShellSpawner = (file, args, options) => {
    const child = new FakeJobProcess()
    calls.push({ file, args, options })
    setImmediate(() => {
      script(child)
    })
    return child
  }
  return { spawn, calls }
}

const LAUNCHER = path.resolve('/opt/app/resources/helpers/job-run.exe')
const verified = (): Promise<JobLauncher> => Promise.resolve({ ok: true, path: LAUNCHER })

describe('run_shell with a job launcher', () => {
  it('starts the shell through the launcher with a report pipe, and reports background processes', async () => {
    const { spawn, calls } = fakeJobSpawner((child) => {
      child.stdout.write('hello\n')
      child.report.write('job-run:1 exit=0 background=2\n')
      child.exit(0)
    })
    const killTree = vi.fn()
    const h = toolHarness(sb, { spawn, killTree, jobLauncher: verified })
    const r = await h
      .tool('run_shell')
      .execute({ command: 'echo hello', cwd: sb.root }, fakeContext(true).ctx)
    const shell = shellInvocation('echo hello', process.platform, process.env)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      file: LAUNCHER,
      args: ['--parent', String(process.pid), '--', shell.file, ...shell.args],
      options: { cwd: sb.root, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true },
    })
    expect(r).toEqual({
      content:
        'exit code: 0\n2 background processes were stopped when the command finished.\n' +
        `cwd: ${sb.root}\n--- stdout ---\nhello\n\n--- stderr ---\n`,
    })
    expect(killTree).not.toHaveBeenCalled()
  })

  it('ignores report lines in the command output: only the report pipe counts', async () => {
    const spoof = 'job-run:1 exit=0 background=99\njob-run:1 error=CreateProcess code=5\n'
    const { spawn } = fakeJobSpawner((child) => {
      child.stdout.write(spoof)
      child.stderr.write(spoof)
      child.report.write('job-run:1 exit=5 background=0\n')
      child.exit(5)
    })
    const h = toolHarness(sb, { spawn, jobLauncher: verified })
    const r = await h
      .tool('run_shell')
      .execute({ command: 'spoof', cwd: sb.root }, fakeContext(true).ctx)
    expect(r.isError).toBeUndefined()
    expect(r.content).toMatch(/^exit code: 5\ncwd: /)
    expect(r.content).not.toMatch(/background processes? (was|were) stopped/)
  })

  it('reports a launcher failure before the command ran', async () => {
    const { spawn } = fakeJobSpawner((child) => {
      child.report.write('job-run:1 error=AssignProcessToJobObject code=5\n')
      child.exit(0x4a520001)
    })
    const h = toolHarness(sb, { spawn, jobLauncher: verified })
    const r = await h
      .tool('run_shell')
      .execute({ command: 'x', cwd: sb.root }, fakeContext(true).ctx)
    expect(r).toMatchObject({
      isError: true,
      content: expect.stringMatching(
        /^Could not run the command in a Job Object: job-run.exe failed at AssignProcessToJobObject \(Windows error 5\)\. Nothing was run\./,
      ) as unknown,
    })
    expect(h.audit.entries[0]).toMatchObject({ outcome: 'error', error: 'spawn-failed' })
  })

  it('says so when the launcher did not report', async () => {
    const { spawn } = fakeJobSpawner((child) => {
      child.exit(3)
    })
    const h = toolHarness(sb, { spawn, jobLauncher: verified })
    const r = await h
      .tool('run_shell')
      .execute({ command: 'x', cwd: sb.root }, fakeContext(true).ctx)
    expect(r.content).toMatch(/^exit code: 3\njob-run.exe did not report how the command ended/)
  })

  it('cancels by killing the launcher, not with the tree kill', async () => {
    const { spawn, calls } = fakeJobSpawner(() => undefined)
    const killTree = vi.fn()
    const h = toolHarness(sb, { spawn, killTree, jobLauncher: verified })
    const { ctx, controller } = fakeContext(true)
    const running = h.tool('run_shell').execute({ command: 'sleep 60', cwd: sb.root }, ctx)
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    controller.abort()
    const r = await running
    expect(r).toMatchObject({
      isError: true,
      content: expect.stringMatching(/^Cancelled; the process tree was killed/) as unknown,
    })
    expect(killTree).not.toHaveBeenCalled()
  })

  it('verifies the launcher for every command, and falls back with the reason', async () => {
    const { spawn, calls } = fakeJobSpawner((child) => {
      child.stdout.write('ok\n')
      child.exit(0)
    })
    const jobLauncher = vi.fn(() =>
      Promise.resolve<JobLauncher>({ ok: false, reason: 'job-run.exe failed its integrity check' }),
    )
    const h = toolHarness(sb, { spawn, jobLauncher })
    for (let i = 0; i < 2; i++) {
      const r = await h
        .tool('run_shell')
        .execute({ command: 'echo ok', cwd: sb.root }, fakeContext(true).ctx)
      expect(r.content).toMatch(/^exit code: 0\n/)
      expect(r.content).toMatch(
        /\nNot run in a Job Object \(job-run.exe failed its integrity check\); processes the command started may still be running\.$/,
      )
    }
    expect(jobLauncher).toHaveBeenCalledTimes(2)
    const shell = shellInvocation('echo ok', process.platform, process.env)
    expect(calls.map((c) => [c.file, c.options.stdio.length])).toEqual([
      [shell.file, 3],
      [shell.file, 3],
    ])
  })

  it('checks the launcher only after approval', async () => {
    const jobLauncher = vi.fn(verified)
    const h = toolHarness(sb, { jobLauncher })
    await h.tool('run_shell').execute({ command: 'x', cwd: sb.root }, fakeContext(false).ctx)
    expect(jobLauncher).not.toHaveBeenCalled()
  })
})
