import { EventEmitter } from 'node:events'
import { readFileSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext, makeSandbox, type Sandbox } from '../permissions/test-support'
import { PathGuard } from '../permissions/guard'
import {
  defaultKillTree,
  shellEnv,
  shellInvocation,
  type ShellProcess,
  type ShellSpawnOptions,
  type ShellSpawner,
  windowsRoot,
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

const okKill = () => Promise.resolve({ ok: true as const })

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
    const h = toolHarness(sb, { spawn, killTree: vi.fn(okKill) })
    const { ctx, requests } = fakeContext(true)
    const r = await h.tool('run_shell').execute({ command: 'echo hello', cwd: sb.root }, ctx)

    const { file, args } = shellInvocation('echo hello', process.platform, process.env)
    // Always an absolute path: never looked up in the cwd or on PATH.
    expect(path.isAbsolute(file)).toBe(true)
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
      // The approved action itself is the core of the audit: exact command and cwd.
      args: { command: 'echo hello', cwd: sb.root },
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
      return okKill()
    })
    const { spawn } = fakeSpawner((child) => {
      child.stdout.write('started\n')
    })
    const h = toolHarness(sb, { spawn, killTree })
    const r = await h
      .tool('run_shell')
      .execute({ command: 'sleep 100', cwd: sb.root, timeoutMs: 1000 }, fakeContext().ctx)
    expect(killTree).toHaveBeenCalledOnce()
    expect(r).toMatchObject({
      isError: true,
      content: /^Timed out after 1 s; the process tree was killed/,
    })
    expect(r.content).toContain('started')
  })

  it('kills the process tree when the call is aborted', async () => {
    const killTree = vi.fn((child: ShellProcess) => {
      ;(child as FakeProcess).exit(null, 'SIGKILL')
      return okKill()
    })
    const { ctx, controller } = fakeContext(true)
    const { spawn } = fakeSpawner(() => {
      controller.abort()
    })
    const h = toolHarness(sb, { spawn, killTree })
    const r = await h.tool('run_shell').execute({ command: 'sleep 100', cwd: sb.root }, ctx)
    expect(killTree).toHaveBeenCalledOnce()
    expect(r).toMatchObject({ isError: true, content: /Cancelled; the process tree was killed/ })
    expect(h.audit.entries[0]).toMatchObject({ outcome: 'error', error: 'cancelled' })
  })

  it('says the tree may still be running when the kill fails', async () => {
    const killTree = vi.fn((child: ShellProcess) => {
      ;(child as FakeProcess).exit(1)
      return Promise.resolve({ ok: false as const, reason: 'taskkill exited with code 128' })
    })
    const { ctx, controller } = fakeContext(true)
    const { spawn } = fakeSpawner(() => {
      controller.abort()
    })
    const h = toolHarness(sb, { spawn, killTree })
    const r = await h.tool('run_shell').execute({ command: 'x', cwd: sb.root }, ctx)
    expect(r).toMatchObject({
      isError: true,
      content:
        /^Cancelled\. The process tree may still be running: taskkill exited with code 128\./,
    })
    expect(r.content).not.toMatch(/was killed/)
    expect(h.audit.entries[0]).toMatchObject({ error: 'kill-failed' })
  })

  it('says the tree may still be running when the shell does not exit after the kill', async () => {
    const { ctx, controller } = fakeContext(true)
    const { spawn } = fakeSpawner(() => {
      controller.abort()
    })
    const h = toolHarness(sb, { spawn, killTree: vi.fn(okKill), limits: { killGraceMs: 50 } })
    const r = await h.tool('run_shell').execute({ command: 'x', cwd: sb.root }, ctx)
    expect(r).toMatchObject({
      isError: true,
      content: /may still be running: the shell did not exit within 0\.05 s/,
    })
  })

  it('refuses to spawn if the cwd was swapped for another folder during approval', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const cwd = path.join(sb.root, 'work')
    await fs.mkdir(cwd)
    const h = toolHarness(sb, { spawn })
    const { ctx } = fakeContext(async () => {
      await fs.rename(cwd, path.join(sb.root, 'work-old'))
      await fs.mkdir(cwd)
      return true
    })
    const r = await h.tool('run_shell').execute({ command: 'ls', cwd }, ctx)
    expect(r).toMatchObject({ isError: true, content: /changed after the command was approved/ })
    expect(calls).toEqual([])
  })

  it('refuses to spawn if the grant was revoked during approval', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    let roots = [sb.root]
    const guard = new PathGuard({ roots: () => roots })
    const h = toolHarness(sb, { spawn, guard })
    const { ctx } = fakeContext(() => {
      roots = []
      return true
    })
    const r = await h.tool('run_shell').execute({ command: 'ls', cwd: sb.root }, ctx)
    expect(r).toMatchObject({ isError: true, content: /Access denied/ })
    expect(calls).toEqual([])
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
  it('runs PowerShell by absolute path under %SystemRoot%, and /bin/sh elsewhere', () => {
    expect(shellInvocation('Get-Date', 'win32', { SystemRoot: 'D:\\WINNT' })).toEqual({
      file: 'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Date'],
    })
    expect(shellInvocation('date', 'linux', {})).toEqual({ file: '/bin/sh', args: ['-c', 'date'] })
  })

  it('falls back to C:\\Windows when %SystemRoot% is missing or not a plain local path', () => {
    for (const SystemRoot of [
      undefined,
      '',
      'Windows',
      '.\\evil',
      '\\\\server\\share',
      'C:\\a;b|c',
      'C:',
    ]) {
      expect(windowsRoot(SystemRoot === undefined ? {} : { SystemRoot }), String(SystemRoot)).toBe(
        'C:\\Windows',
      )
    }
    expect(windowsRoot({ windir: 'E:\\Windows' })).toBe('E:\\Windows')
  })
})

describe('defaultKillTree', () => {
  it('runs taskkill /T /F by absolute path with a minimal environment', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const result = await defaultKillTree('win32', spawn, {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\evil',
    })(new FakeProcess())
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      file: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '4242', '/T', '/F'],
      options: { env: { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' } },
    })
  })

  it("reports taskkill's failure instead of assuming success", async () => {
    const failing = fakeSpawner((child) => {
      child.exit(128)
    })
    expect(await defaultKillTree('win32', failing.spawn, {})(new FakeProcess())).toEqual({
      ok: false,
      reason: 'taskkill exited with code 128',
    })
    const missing = fakeSpawner((child) => {
      child.emit('error', new Error('ENOENT'))
    })
    expect(await defaultKillTree('win32', missing.spawn, {})(new FakeProcess())).toMatchObject({
      ok: false,
      reason: /taskkill could not start/,
    })
  })

  it('kills the process group elsewhere, falling back to the child', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const child = new FakeProcess()
    expect(await defaultKillTree('linux', fakeSpawner(() => undefined).spawn, {})(child)).toEqual({
      ok: true,
    })
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

  it('kills grandchildren too when aborted', { timeout: 60_000 }, async () => {
    const h = toolHarness(sb)
    const { ctx, controller } = fakeContext(true)
    const pidFile = path.join(sb.root, 'grandchild.pid')
    const command =
      process.platform === 'win32'
        ? '$p = Start-Process -FilePath "$env:SystemRoot\\System32\\PING.EXE" ' +
          "-ArgumentList '-n','300','127.0.0.1' -PassThru -NoNewWindow; " +
          'Set-Content -Path grandchild.pid -Value $p.Id; Start-Sleep 300'
        : 'sleep 300 & echo $! > grandchild.pid; wait'
    const running = h.tool('run_shell').execute({ command, cwd: sb.root }, ctx)
    const grandchild = await waitForPid(pidFile, 30_000)
    expect(isAlive(grandchild)).toBe(true)
    controller.abort()
    const r = await running
    expect(r).toMatchObject({ isError: true, content: /^Cancelled; the process tree was killed/ })
    expect(await waitUntil(() => !isAlive(grandchild), 10_000)).toBe(true)
  })

  it.runIf(process.platform === 'win32')(
    'ignores a powershell.exe planted in the working folder',
    { timeout: 30_000 },
    async () => {
      const root = windowsRoot(process.env)
      await fs.copyFile(`${root}\\System32\\whoami.exe`, path.join(sb.root, 'powershell.exe'))
      const h = toolHarness(sb)
      const r = await h
        .tool('run_shell')
        .execute({ command: 'Write-Output shell-ok', cwd: sb.root }, fakeContext(true).ctx)
      expect(r.content).toMatch(/^exit code: 0/)
      expect(r.content).toContain('shell-ok')
    },
  )
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // In a container whose init does not reap, a killed child lingers as a zombie.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
    } catch {
      return false
    }
  }
  return true
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

async function waitForPid(file: string, ms: number): Promise<number> {
  let pid = NaN
  await waitUntil(() => {
    try {
      pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    } catch {
      return false
    }
    return Number.isInteger(pid) && pid > 0
  }, ms)
  if (!Number.isInteger(pid)) throw new Error('the grandchild never started')
  return pid
}
