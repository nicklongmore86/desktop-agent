import { EventEmitter } from 'node:events'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext, makeSandbox, type Sandbox } from '../permissions/test-support'
import {
  defaultKillTree,
  shellEnv,
  shellInvocation,
  type ShellProcess,
  type ShellSpawnOptions,
  type ShellSpawner,
} from './run-shell'
import { toolHarness } from './test-support'

class FakeProcess extends EventEmitter implements ShellProcess {
  readonly pid = 4242
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)

  /** Ends the streams and reports an exit, like a real process closing. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('close', code, signal))
  }
}

interface SpawnCall {
  file: string
  args: readonly string[]
  options: ShellSpawnOptions
  child: FakeProcess
}

function fakeSpawner(script: (child: FakeProcess, call: SpawnCall) => void): {
  spawn: ShellSpawner
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  const spawn: ShellSpawner = (file, args, options) => {
    const child = new FakeProcess()
    const call = { file, args, options, child }
    calls.push(call)
    setImmediate(() => {
      script(child, call)
    })
    return child
  }
  return { spawn, calls }
}

let sb: Sandbox

beforeEach(async () => {
  sb = await makeSandbox()
})

afterEach(async () => {
  vi.useRealTimers()
  await sb.cleanup()
})

describe('run_shell', () => {
  it('asks with the exact command and cwd, then returns exit code and output', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.stdout.write('hello\n')
      child.stderr.write('warn\n')
      child.exit(3)
    })
    const h = toolHarness(sb, { spawn, killTree: vi.fn() })
    const { ctx, requests } = fakeContext(true)
    const r = await h.tool('run_shell').execute({ command: 'echo hello', cwd: sb.root }, ctx)

    const { file, args } = shellInvocation('echo hello', process.platform)
    expect(requests).toEqual([
      {
        tool: 'run_shell',
        kind: 'shell',
        summary: `Run a command in ${sb.root}`,
        detail: `cwd: ${sb.root}\nshell: ${[file, ...args.slice(0, -1)].join(' ')}\n\necho hello`,
      },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file, args, options: { cwd: sb.root, windowsHide: true } })
    expect(r).toEqual({
      content: `exit code: 3\ncwd: ${sb.root}\n--- stdout ---\nhello\n\n--- stderr ---\nwarn\n`,
    })
    expect(h.audit.entries[0]).toMatchObject({
      tool: 'run_shell',
      approval: 'approved',
      outcome: 'ok',
    })
  })

  it('never spawns when declined', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const h = toolHarness(sb, { spawn })
    const r = await h
      .tool('run_shell')
      .execute({ command: 'rm -rf /', cwd: sb.root }, fakeContext(false).ctx)
    expect(r).toMatchObject({ isError: true, content: /declined/ })
    expect(calls).toEqual([])
    expect(h.audit.entries[0]).toMatchObject({ approval: 'denied', outcome: 'error' })
  })

  it('never spawns when cancelled during approval', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const h = toolHarness(sb, { spawn })
    const { ctx, controller } = fakeContext(() => {
      controller.abort()
      return true
    })
    expect(await h.tool('run_shell').execute({ command: 'ls', cwd: sb.root }, ctx)).toMatchObject({
      isError: true,
    })
    expect(calls).toEqual([])
  })

  it('requires the cwd to be inside a grant, and never asks otherwise', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const h = toolHarness(sb, { spawn })
    const { ctx, requests } = fakeContext(true)
    for (const cwd of [
      sb.outside,
      path.join(sb.root, '..'),
      path.join(sb.root, 'missing'),
      'relative',
    ]) {
      expect(await h.tool('run_shell').execute({ command: 'ls', cwd }, ctx), cwd).toMatchObject({
        isError: true,
      })
    }
    expect(requests).toEqual([])
    expect(calls).toEqual([])
  })

  it('validates input', async () => {
    const h = toolHarness(sb)
    const ctx = fakeContext(true).ctx
    expect(await h.tool('run_shell').execute({ command: '  ', cwd: sb.root }, ctx)).toMatchObject({
      isError: true,
      content: /empty/,
    })
    expect(
      await h.tool('run_shell').execute({ command: 'ls', cwd: sb.root, timeoutMs: 5 }, ctx),
    ).toMatchObject({
      isError: true,
      content: /timeoutMs/,
    })
  })

  it('kills the process tree on timeout', async () => {
    const killTree = vi.fn((child: ShellProcess) => {
      ;(child as FakeProcess).exit(null, 'SIGKILL')
    })
    const { spawn } = fakeSpawner((child) => {
      child.stdout.write('started\n')
    })
    const h = toolHarness(sb, { spawn, killTree })
    const r = await h
      .tool('run_shell')
      .execute({ command: 'sleep 100', cwd: sb.root, timeoutMs: 1000 }, fakeContext().ctx)
    expect(killTree).toHaveBeenCalledOnce()
    expect(r).toMatchObject({ isError: true, content: /Timed out after 1 s/ })
    expect(r.content).toContain('started')
  })

  it('kills the process tree when the call is aborted', async () => {
    const killTree = vi.fn((child: ShellProcess) => {
      ;(child as FakeProcess).exit(null, 'SIGKILL')
    })
    const { ctx, controller } = fakeContext(true)
    const { spawn } = fakeSpawner(() => {
      controller.abort()
    })
    const h = toolHarness(sb, { spawn, killTree })
    const r = await h.tool('run_shell').execute({ command: 'sleep 100', cwd: sb.root }, ctx)
    expect(killTree).toHaveBeenCalledOnce()
    expect(r).toMatchObject({ isError: true, content: /Cancelled; the process was killed/ })
  })

  it('caps output, keeping the start and the end', async () => {
    const { spawn } = fakeSpawner((child) => {
      child.stdout.write('A'.repeat(50))
      child.stdout.write('B'.repeat(1000))
      child.stdout.write('C'.repeat(50))
      child.exit(0)
    })
    const h = toolHarness(sb, { spawn, limits: { maxShellOutputBytes: 100 } })
    const r = await h
      .tool('run_shell')
      .execute({ command: 'spam', cwd: sb.root }, fakeContext().ctx)
    expect(r.content).toContain(`${'A'.repeat(50)}\n… [1000 B omitted] …\n${'C'.repeat(50)}`)
  })

  it('reports spawn errors', async () => {
    const { spawn } = fakeSpawner((child) => {
      child.emit('error', new Error('ENOENT powershell.exe'))
    })
    const h = toolHarness(sb, { spawn })
    expect(
      await h.tool('run_shell').execute({ command: 'x', cwd: sb.root }, fakeContext().ctx),
    ).toMatchObject({
      isError: true,
      content: /ENOENT powershell\.exe/,
    })
  })

  it('passes a filtered environment and redacts secrets in the audit log', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const h = toolHarness(sb, {
      spawn,
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-xyz', ELECTRON_RUN_AS_NODE: '1' },
    })
    await h
      .tool('run_shell')
      .execute({ command: '$env:API_TOKEN="hunter2"; gh api', cwd: sb.root }, fakeContext(true).ctx)
    expect(calls[0]?.options.env).toEqual({ PATH: '/bin' })
    expect(JSON.stringify(h.audit.entries)).not.toContain('hunter2')
  })
})

describe('shellInvocation', () => {
  it('uses non-interactive PowerShell on Windows and /bin/sh elsewhere', () => {
    expect(shellInvocation('Get-Date', 'win32')).toEqual({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Date'],
    })
    expect(shellInvocation('date', 'linux')).toEqual({ file: '/bin/sh', args: ['-c', 'date'] })
  })
})

describe('defaultKillTree', () => {
  it('uses taskkill /T /F on Windows', () => {
    const { spawn, calls } = fakeSpawner(() => undefined)
    defaultKillTree('win32', spawn, () => 'C:\\')(new FakeProcess())
    expect(calls.map((c) => [c.file, c.args])).toEqual([['taskkill', ['/pid', '4242', '/T', '/F']]])
  })

  it('kills the process group elsewhere, falling back to the child', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const child = new FakeProcess()
    defaultKillTree('linux', fakeSpawner(() => undefined).spawn, () => '/')(child)
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    killSpy.mockRestore()
  })
})

describe('shellEnv', () => {
  it("drops the app's own variables", () => {
    expect(
      shellEnv({ Path: 'x', anthropic_api_key: 'k', ELECTRON_NO_ASAR: '1', HOME: '/h' }),
    ).toEqual({
      Path: 'x',
      HOME: '/h',
    })
  })
})

// Real processes, on whichever OS runs the tests (PowerShell on the Windows CI runner).
describe('run_shell with a real shell', () => {
  it('runs a command in the cwd', { timeout: 30_000 }, async () => {
    const h = toolHarness(sb)
    const command = process.platform === 'win32' ? 'Write-Output (Get-Location).Path' : 'pwd'
    const r = await h.tool('run_shell').execute({ command, cwd: sb.root }, fakeContext(true).ctx)
    expect(r.isError).toBeUndefined()
    expect(r.content).toMatch(/^exit code: 0/)
    expect(r.content.toLowerCase()).toContain(sb.root.toLowerCase())
  })

  it('kills a long-running command on abort', { timeout: 30_000 }, async () => {
    const h = toolHarness(sb)
    const { ctx, controller } = fakeContext(true)
    const started = Date.now()
    setTimeout(() => {
      controller.abort()
    }, 1500)
    const r = await h.tool('run_shell').execute({ command: 'sleep 60', cwd: sb.root }, ctx)
    expect(r).toMatchObject({ isError: true, content: /Cancelled/ })
    expect(Date.now() - started).toBeLessThan(20_000)
  })
})
