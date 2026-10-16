import { EventEmitter } from 'node:events'
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext, makeSandbox, type Sandbox } from '../permissions/test-support'
import { PathGuard } from '../permissions/guard'
import {
  defaultKillTree,
  OutputCollector,
  shellEnv,
  shellInvocation,
  type ShellProcess,
  type ShellSpawnOptions,
  type ShellSpawner,
  windowsRoot,
} from './run-shell'
import {
  decodeCliXml,
  encodePowerShell,
  powerShellScript,
  treeKillScript,
  UTF8_PREAMBLE,
} from './shell-windows'
import type { ApprovalPrompt, ChatEvent } from '../../shared/ipc'
import { ChatSession } from '../chat/session'
import { memoryHistory, memoryStore } from '../chat/test-support'
import { toTranscript } from '../chat/transcript'
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
      // The agent asked for it: only the command bar's runs are 'user-terminal'.
      origin: 'agent',
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
    // A command that never ran is not logged verbatim, only its shape.
    expect(h.audit.entries[0]).toMatchObject({
      approval: 'denied',
      outcome: 'error',
      args: { commandLength: 8, cwd: sb.root, timeoutMs: 60_000 },
    })
    expect(JSON.stringify(h.audit.entries)).not.toContain('rm -rf')
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

const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf16le')

describe('shellInvocation', () => {
  it('runs PowerShell by absolute path under %SystemRoot%, and /bin/sh elsewhere', () => {
    expect(shellInvocation('Get-Date', 'win32', { SystemRoot: 'D:\\WINNT' })).toEqual({
      file: 'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)],
    })
    expect(shellInvocation('date', 'linux', {})).toEqual({ file: '/bin/sh', args: ['-c', 'date'] })
  })

  it('passes the exact command as base64 UTF-16LE after the UTF-8 preamble', () => {
    const command = `Write-Output "a \\"b\\" 'c''d' \`$x"; # café 日本語 😀\r\nexit 3\\`
    const { args } = shellInvocation(command, 'win32', {})
    const encoded = args.at(-1) ?? ''
    // Nothing a command-line parser could reinterpret.
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(encoded).toBe(encodePowerShell(powerShellScript(command)))
    expect(decode(encoded)).toBe(`${UTF8_PREAMBLE}\n${command}`)
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

  it('falls back to a PowerShell tree kill when taskkill fails or cannot start', async () => {
    for (const taskkill of ['exit', 'error', 'throw'] as const) {
      const calls: SpawnCall[] = []
      const spawn: ShellSpawner = (file, args, options) => {
        const child = new FakeProcess()
        calls.push({ file, args, options, child })
        if (file.endsWith('taskkill.exe') && taskkill === 'throw') throw new Error('EACCES')
        setImmediate(() => {
          if (!file.endsWith('taskkill.exe')) child.exit(0)
          else if (taskkill === 'exit') child.exit(1)
          else child.emit('error', new Error('ENOENT'))
        })
        return child
      }
      const shell = new FakeProcess()
      expect(await defaultKillTree('win32', spawn, { SystemRoot: 'C:\\Windows' })(shell)).toEqual({
        ok: true,
      })
      expect(calls.map((c) => c.file)).toEqual([
        'C:\\Windows\\System32\\taskkill.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ])
      const fallback = calls[1]
      expect(fallback?.args.slice(0, -1)).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
      ])
      expect(decode(fallback?.args.at(-1) ?? '')).toBe(treeKillScript(4242))
      expect(fallback?.options.env).toEqual({ SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' })
      expect(shell.kill).toHaveBeenCalledWith('SIGKILL')
    }
  })

  it('reports failure, with both reasons, when taskkill and the fallback fail', async () => {
    const failing = fakeSpawner((child) => {
      child.exit(128)
    })
    expect(await defaultKillTree('win32', failing.spawn, {})(new FakeProcess())).toEqual({
      ok: false,
      reason: 'taskkill exited with code 128; the PowerShell fallback exited with code 128',
    })
    const missing = fakeSpawner((child) => {
      child.emit('error', new Error('ENOENT'))
    })
    expect(await defaultKillTree('win32', missing.spawn, {})(new FakeProcess())).toMatchObject({
      ok: false,
      reason: /^taskkill could not start: ENOENT; the PowerShell fallback could not start/,
    })
  })

  it('only builds a tree-kill script for a real pid', () => {
    expect(treeKillScript(77)).toContain('$queue.Enqueue(77)')
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(() => treeKillScript(pid)).toThrow()
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

describe('decodeCliXml', () => {
  // What Windows PowerShell 5.1 wrote to stderr on the CI runner.
  const sample =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>' +
    '<T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV>' +
    '<AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>' +
    '<S S="Error">Write-Error \'bad café _xD83D__xDE00_\' : bad &lt;café&gt; &amp; _x005F_x_xD83D__xDE00__x000D__x000A_</S>' +
    '<S S="Error">    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException_x000D__x000A_</S>' +
    '<S S="warning">careful</S></Objs>'

  it('turns PowerShell stream records back into console text and drops progress', () => {
    expect(decodeCliXml(sample)).toBe(
      "Write-Error 'bad café 😀' : bad <café> & _x😀\r\n" +
        '    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException\r\n' +
        'WARNING: careful\n',
    )
  })

  it('leaves numeric entities that are not Unicode scalar values as they are', () => {
    expect(
      decodeCliXml('<S S="Error">a &#x110000; &#99999999; &#xD800; &#57343; &#65;&#x1F600; b</S>'),
    ).toBe('a &#x110000; &#99999999; &#xD800; &#57343; A😀 b')
  })

  it('repairs markup broken where the output was cut', () => {
    // Cut at the end: a partial tag, escape or progress record is dropped and an open string closed.
    expect(decodeCliXml('<S S="Error">ok</S><S S="Err', { end: true })).toBe('ok')
    expect(decodeCliXml('<S S="Error">done_x000D__x0', { end: true })).toBe('done\r')
    expect(decodeCliXml('<S S="Error">a &am', { end: true })).toBe('a ')
    expect(
      decodeCliXml('<S S="Error">x</S><Obj S="progress" RefId="0"><AV>pp', { end: true }),
    ).toBe('x')
    // Cut at the start: a partial tag, escape or progress record is dropped and a string opened.
    expect(decodeCliXml('="Error">mid</S>', { start: true })).toBe('mid')
    expect(decodeCliXml('D__x000A_</S><S S="Error">next</S>', { start: true })).toBe('\nnext')
    expect(decodeCliXml('p;b</S>', { start: true })).toBe('b')
    expect(decodeCliXml('p</AV></Obj><S S="Error">x</S></Objs>', { start: true })).toBe('x')
    // Without a cut, nothing is repaired.
    expect(decodeCliXml('<S S="Error">ok</S><S S="Err')).toBe('ok<S S="Err')
  })

  it('leaves plain text alone, and decodes fragments of cut output', () => {
    expect(decodeCliXml('plain _x0041_ <b> text')).toBe('plain _x0041_ <b> text')
    expect(decodeCliXml('ion</S><S S="Error">tail_x000A_</S></Objs>')).toBe('ion</S>tail\n')
  })
})

describe('OutputCollector', () => {
  const header =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'

  function collect(limit: number, text: string, chunkSize = 3): OutputCollector {
    const collector = new OutputCollector(limit)
    const bytes = Buffer.from(text)
    for (let i = 0; i < bytes.length; i += chunkSize)
      collector.push(bytes.subarray(i, i + chunkSize))
    return collector
  }

  it('decodes the whole output at once when nothing was dropped', () => {
    // 8 bytes: the head/tail boundary (byte 4) falls inside 日 (bytes 3-5).
    const decode = vi.fn((text: string) => text)
    expect(collect(8, 'abc日de').text(decode)).toBe('abc日de')
    expect(decode).toHaveBeenCalledExactlyOnceWith('abc日de', {})

    const message = `bad café 日本語 ${'z'.repeat(150)}`
    const xml = `${header}<S S="Error">${message}_x000D__x000A_</S></Objs>`
    const boundary = Math.ceil(Buffer.byteLength(xml) / 2)
    // The boundary is inside the <S S="Error"> element.
    expect(Buffer.from(xml).subarray(0, boundary).toString()).toContain('<S S="Error">bad')
    expect(Buffer.from(xml).subarray(boundary).toString()).toContain('</S>')
    expect(collect(Buffer.byteLength(xml), xml).text(decodeCliXml)).toBe(`${message}\r\n`)
  })

  it('never shows half a UTF-8 character at the cut, and counts it as omitted', () => {
    // Head keeps 4 bytes ("abc" + 1 of 日's 3), tail 4 (2 of 日's 3 + "de").
    const text = `abc日${'x'.repeat(20)}日de`
    const out = collect(8, text).text()
    expect(out).toBe(`abc\n… [${String(Buffer.byteLength(text) - 5)} B omitted] …\nde`)
    expect(out).not.toContain('\uFFFD')
  })

  it('decodes each side of the cut without raw markup when a stream string straddles it', () => {
    const open = '<S S="Error">'
    const k = Buffer.byteLength(header + open) + 20
    const xml =
      `${header}${open}${'A'.repeat(40)}_x000D__x000A_</S>` +
      `<Obj S="progress" RefId="0"><AV>${'p'.repeat(200)}</AV></Obj>` +
      `${open}${'B'.repeat(k)}_x000A_</S></Objs>`
    const out = collect(2 * k, xml).text(decodeCliXml)
    const dropped = Buffer.byteLength(xml) - 2 * k
    expect(out).toBe(
      `${'A'.repeat(20)}\n… [${String(dropped)} B omitted] …\n${'B'.repeat(k - 18)}\n`,
    )
  })

  it('cuts a stream string between the bytes of a multibyte character', () => {
    const open = '<S S="Error">'
    const k = Buffer.byteLength(header + open) + 4
    // Byte k falls inside the second 日 of the head; the tail's first k bytes start inside 本.
    const xml = `${header}${open}日日日${'x'.repeat(100)}</S>${open}本${'y'.repeat(k - 13)}</S></Objs>`
    const out = collect(2 * k, xml).text(decodeCliXml)
    expect(out).toMatch(/^日\n… \[\d+ B omitted\] …\ny+$/)
    expect(out).not.toMatch(/\uFFFD|<|>/)
  })
})

describe('shellEnv', () => {
  it("drops the app's own variables", () => {
    expect(
      shellEnv({ Path: 'x', anthropic_api_key: 'k', ELECTRON_NO_ASAR: '1', HOME: '/h' }, 'win32'),
    ).toEqual({
      Path: 'x',
      HOME: '/h',
    })
  })

  it('passes only allowlisted variables, matching case-insensitively on Windows', () => {
    const kept = {
      Path: 'C:\\bin',
      SYSTEMROOT: 'C:\\Windows',
      windir: 'C:\\Windows',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.EXE',
      TEMP: 't',
      tmp: 't',
      USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'a',
      LocalAppData: 'l',
      ProgramFiles: 'p',
      'ProgramFiles(x86)': 'p86',
      ProgramW6432: 'p64',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
    }
    const env = {
      ...kept,
      NODE_OPTIONS: '--require evil.js',
      SECRET_THING: 's',
      AWS_SECRET_ACCESS_KEY: 's',
      npm_config_registry: 'r',
    }
    expect(shellEnv(env, 'win32')).toEqual(kept)
    // POSIX names are case-sensitive: "Path" and "comspec" are not PATH and ComSpec there.
    expect(
      shellEnv({ PATH: '/bin', Path: 'x', HOME: '/h', LC_CTYPE: 'C', TMPDIR: '/t' }, 'linux'),
    ).toEqual({
      PATH: '/bin',
      HOME: '/h',
      LC_CTYPE: 'C',
      TMPDIR: '/t',
    })
  })

  it('keeps one of several names that differ only in case on Windows', () => {
    expect(shellEnv({ Path: 'first', PATH: 'second' }, 'win32')).toEqual({ Path: 'first' })
  })

  it('never passes credentials or app variables, even with allowlisted-looking names', () => {
    const denied = {
      ANTHROPIC_API_KEY: 'k',
      anthropic_base_url: 'u',
      OPENAI_API_KEY: 'k',
      CODEX_HOME: 'c',
      CLAUDE_CONFIG_DIR: 'c',
      ELECTRON_RUN_AS_NODE: '1',
      GITHUB_TOKEN: 't',
      LC_API_KEY: 'k',
      LC_TOKEN: 't',
      MY_API_KEY_FILE: 'f',
    }
    for (const platform of ['win32', 'linux'] as const) {
      expect(shellEnv({ ...denied, PATH: '/bin' }, platform), platform).toEqual({ PATH: '/bin' })
    }
  })
})

// Real processes, on whichever OS runs the tests (PowerShell on the Windows CI runner).
describe('run_shell with a real shell', () => {
  // Headroom for a busy Windows runner; these commands normally take a second or two.
  const SHELL_MS = 120_000

  // The first cmdlet a fresh Windows PowerShell looks up can take over a minute while it
  // indexes the installed modules; pay that once, here, not inside a test's budget.
  beforeAll(async () => {
    if (process.platform !== 'win32') return
    const warm = await makeSandbox()
    try {
      const r = await toolHarness(warm)
        .tool('run_shell')
        .execute(
          { command: 'Write-Output (Get-Location).Path', cwd: warm.root, timeoutMs: 240_000 },
          fakeContext(true).ctx,
        )
      expect(r.content).toMatch(/^exit code: 0/)
    } finally {
      await fs.rm(warm.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 300_000)

  // Windows can briefly refuse to remove a folder a process has just stopped using.
  afterEach(async () => {
    await fs.rm(sb.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }, 30_000)

  it('runs a command in the cwd', { timeout: SHELL_MS }, async () => {
    const h = toolHarness(sb)
    const command = process.platform === 'win32' ? 'Write-Output (Get-Location).Path' : 'pwd'
    const r = await h.tool('run_shell').execute({ command, cwd: sb.root }, fakeContext(true).ctx)
    expect(r.isError).toBeUndefined()
    expect(r.content).toMatch(/^exit code: 0/)
    expect(r.content.toLowerCase()).toContain(sb.root.toLowerCase())
  })

  it('kills a long-running command on abort', { timeout: SHELL_MS }, async () => {
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

  // The shell starts a child, which starts a grandchild; both pids are written down.
  const treeCommand =
    process.platform === 'win32'
      ? '$p = Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ' +
        "-ArgumentList '-NoProfile','-NonInteractive','-Command'," +
        "'$g = Start-Process -FilePath \"$env:SystemRoot\\System32\\PING.EXE\" -ArgumentList ''-n'',''300'',''127.0.0.1'' -PassThru -NoNewWindow; " +
        "Set-Content -Path grandchild.pid -Value $g.Id; Start-Sleep 300' -PassThru -NoNewWindow; " +
        'Set-Content -Path child.pid -Value $p.Id; Start-Sleep 300'
      : "sh -c 'sleep 300 & echo $! > grandchild.pid; wait' & echo $! > child.pid; wait"

  async function expectTreeKilled(
    overrides: Parameters<typeof toolHarness>[1],
    stop: 'timeout' | 'cancel',
  ): Promise<void> {
    const h = toolHarness(sb, overrides)
    const { ctx, controller } = fakeContext(true)
    const running = h.tool('run_shell').execute(
      // Long enough for PowerShell to start both processes on a slow CI runner.
      { command: treeCommand, cwd: sb.root, timeoutMs: stop === 'timeout' ? 15_000 : 300_000 },
      ctx,
    )
    let pinned: Pinned = { pids: [], release: () => undefined }
    try {
      const child = await waitForPid(path.join(sb.root, 'child.pid'), 60_000)
      const grandchild = await waitForPid(path.join(sb.root, 'grandchild.pid'), 60_000)
      pinned = await pinProcesses([child, grandchild], 60_000)
      expect(isAlive(child)).toBe(true)
      expect(isAlive(grandchild)).toBe(true)
      if (stop === 'cancel') controller.abort()
      const r = await running
      expect(r).toMatchObject({
        isError: true,
        content:
          stop === 'cancel'
            ? /^Cancelled; the process tree was killed/
            : /^Timed out after 15 s; the process tree was killed/,
      })
      expect(await waitUntil(() => !isAlive(child) && !isAlive(grandchild), 10_000)).toBe(true)
    } finally {
      // Whatever failed above, leave nothing running in the sandbox: it would hold the
      // folder open and fail the next steps with EBUSY.
      controller.abort()
      await running
      // Only pinned pids are certain to still be the processes the shell started.
      for (const pid of pinned.pids.filter(isAlive)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Exited in the meantime.
        }
      }
      await waitUntil(() => !pinned.pids.some(isAlive), 10_000)
      pinned.release()
    }
  }

  for (const stop of ['cancel', 'timeout'] as const) {
    it(`kills children and grandchildren on ${stop}`, { timeout: 150_000 }, async () => {
      await expectTreeKilled({}, stop)
    })
  }

  it.runIf(process.platform === 'win32')(
    'kills the whole tree with the PowerShell fallback when taskkill cannot start',
    { timeout: 150_000 },
    async () => {
      const spawn: ShellSpawner = (file, args, options) => {
        if (file.toLowerCase().endsWith('taskkill.exe')) throw new Error('taskkill blocked by test')
        return nodeSpawn(file, args, options)
      }
      await expectTreeKilled({ spawn, limits: { killGraceMs: 20_000 } }, 'cancel')
    },
  )

  const nonAscii = 'café Ünïcödé 日本語 中文 한국어 😀'

  it('returns non-ASCII stdout and stderr as UTF-8', { timeout: SHELL_MS }, async () => {
    const h = toolHarness(sb)
    const command =
      process.platform === 'win32'
        ? `Write-Output '${nonAscii}'; [Console]::Error.WriteLine('err ${nonAscii}')`
        : `printf '%s\\n' '${nonAscii}'; printf '%s\\n' 'err ${nonAscii}' >&2`
    const r = await h.tool('run_shell').execute({ command, cwd: sb.root }, fakeContext(true).ctx)
    const content = r.content.replaceAll('\r\n', '\n')
    expect(content).toMatch(/^exit code: 0/)
    expect(content).toContain(`--- stdout ---\n${nonAscii}\n`)
    expect(content).toContain(`--- stderr ---\nerr ${nonAscii}\n`)
    expect(content).not.toContain('\uFFFD')
  })

  it('writes errors to stderr as plain text', { timeout: SHELL_MS }, async () => {
    // The progress text is built at run time: error messages repeat the script itself.
    const h = toolHarness(sb)
    const command =
      process.platform === 'win32'
        ? `Write-Progress -Activity ('bu' + 'sy') -Status x\nWrite-Warning 'careful <&>'\nWrite-Error 'bad café 日本語 😀'\nexit 2`
        : `echo 'WARNING: careful <&>' >&2; echo 'bad café 日本語 😀' >&2; exit 2`
    const r = await h.tool('run_shell').execute({ command, cwd: sb.root }, fakeContext(true).ctx)
    expect(r.content).toMatch(/^exit code: 2/)
    expect(r.content).toMatch(/--- stderr ---\r?\nWARNING: careful <&>\r?\n/)
    expect(r.content).toContain('bad café 日本語 😀')
    expect(r.content).not.toMatch(/CLIXML|<Objs|<S S=|_x[0-9A-F]{4}_|busy/)
  })

  it('runs the approved command exactly, quotes and all', { timeout: SHELL_MS }, async () => {
    const h = toolHarness(sb)
    const { ctx, requests } = fakeContext(true)
    // A backslash before a closing quote is where -Command quoting used to go wrong.
    // (~ stands for PowerShell's backtick escape.)
    const command =
      process.platform === 'win32'
        ? String.raw`$x = 'it''s'; Write-Output "[$x] ~"q~" ""r"" ~$notvar a\" 'b"c' '%PATH%' '^&|<>'`.replaceAll(
            '~',
            '`',
          ) + '\nexit 7'
        : String.raw`x="it's"; printf '%s\n' "[$x] \"q\" \"r\" \$notvar a\\" 'b"c' '%PATH%' '^&|<>'` +
          '\nexit 7'
    const r = await h.tool('run_shell').execute({ command, cwd: sb.root }, ctx)
    // The approval shows the original text, not the encoded form.
    expect(requests[0]?.detail?.endsWith(`\n\n${command}`)).toBe(true)
    const out = '[it\'s] "q" "r" $notvar a\\\nb"c\n%PATH%\n^&|<>'
    expect(r.content).toMatch(/^exit code: 7/)
    expect(r.content.replaceAll('\r\n', '\n')).toContain(
      `--- stdout ---\n${out}\n\n--- stderr ---\n`,
    )
  })

  it("does not leak the app's credentials into the shell", { timeout: SHELL_MS }, async () => {
    const h = toolHarness(sb, {
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-leak', DESKTOP_AGENT_SECRET: 'leak2' },
    })
    const command =
      process.platform === 'win32'
        ? 'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" }'
        : 'env'
    const r = await h.tool('run_shell').execute({ command, cwd: sb.root }, fakeContext(true).ctx)
    expect(r.content).toMatch(/^exit code: 0/)
    expect(r.content).toMatch(/^PATH=/im)
    expect(r.content).not.toContain('sk-leak')
    expect(r.content).not.toContain('leak2')
  })

  it.runIf(process.platform === 'win32')(
    'ignores a powershell.exe planted in the working folder',
    { timeout: SHELL_MS },
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

const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
)

/** Starts Windows PowerShell outside the sandbox, so it never holds the sandbox open. */
function startPowerShell(script: string): ChildProcess {
  return nodeSpawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

interface Pinned {
  pids: number[]
  release: () => void
}

/**
 * Windows hands a freed pid to the next new process almost at once, so on a busy runner
 * `isAlive(pid)` can report an unrelated process. Holding an open handle to each process
 * keeps its pid reserved (and reported as exited once it dies) until `release`.
 */
function pinProcesses(pids: number[], ms: number): Promise<Pinned> {
  if (process.platform !== 'win32') return Promise.resolve({ pids, release: () => undefined })
  const ps = startPowerShell(
    `$ErrorActionPreference = 'Stop'; $all = @(Get-Process -Id ${pids.join(',')}); ` +
      `foreach ($p in $all) { $null = $p.Handle }; [Console]::Out.WriteLine('pinned'); ` +
      // Hold the handles until the test closes stdin.
      `$null = [Console]::In.ReadLine()`,
  )
  const release = (): void => {
    ps.stdin?.end()
    ps.kill()
  }
  let output = ''
  ps.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      release()
      reject(new Error(`could not pin ${pids.join(', ')} within ${String(ms)} ms`))
    }, ms)
    ps.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (!output.includes('pinned')) return
      clearTimeout(timer)
      resolve({ pids, release })
    })
    ps.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    ps.once('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`could not pin ${pids.join(', ')} (exit ${String(code)}): ${output}`))
    })
  })
}

/**
 * The command bar: ChatSession.runCommand over the real run_shell tool, with the same
 * fakes. A typed command is the same approval-gated call as the agent's, audited as
 * `user-terminal`.
 */
describe('run_shell from the command bar', () => {
  function commandSession(
    overrides: Parameters<typeof toolHarness>[1],
    answer: (prompt: ApprovalPrompt) => boolean | null = () => true,
    /** What a chat reply waits for before it ends. */
    reply: Promise<void> = Promise.resolve(),
  ) {
    const h = toolHarness(sb, overrides)
    const events: ChatEvent[] = []
    const prompts: ApprovalPrompt[] = []
    const store = memoryStore()
    let n = 0
    const session: ChatSession = new ChatSession({
      history: memoryHistory(store),
      createRunner: () =>
        Promise.resolve({
          ok: true,
          runner: {
            run: async (conversation) => {
              await reply
              return { conversation, stopReason: 'end_turn' }
            },
          },
        }),
      emit: (event) => events.push(event),
      promptApproval: (prompt) => {
        prompts.push(prompt)
        const approved = answer(prompt)
        if (approved !== null) setImmediate(() => session.respondApproval(prompt.id, approved))
      },
      newId: () => `id-${String(++n)}`,
      userShell: h.tool('run_shell'),
    })
    return { h, session, events, prompts, store }
  }

  /** Waits (up to 10 s: folder checks are slow on Windows runners) until `done` holds. */
  async function until(done: () => boolean): Promise<void> {
    for (const start = Date.now(); !done() && Date.now() - start < 10_000;) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  const commandResult = (events: ChatEvent[]) =>
    events.find((event) => event.type === 'tool_result')

  async function settled(session: ChatSession): Promise<void> {
    await session.idle()
  }

  it('asks with the exact shell, cwd and command, runs it hardened, and audits it as user-terminal', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.stdout.write('hello\n')
      child.exit(0)
    })
    const { h, session, events, prompts, store } = commandSession({
      spawn,
      killTree: vi.fn(okKill),
    })
    const command = process.platform === 'win32' ? 'Write-Output hello' : 'echo hello'

    expect(await session.runCommand(command, sb.root)).toEqual({ ok: true })
    await settled(session)

    const { file, args } = shellInvocation(command, process.platform, process.env)
    expect(prompts).toEqual([
      {
        id: 'id-3',
        runId: 'id-1',
        toolUseId: 'id-2',
        tool: 'run_shell',
        kind: 'shell',
        summary: `Run a command in ${sb.root}`,
        detail: `cwd: ${sb.root}\nshell: ${[file, ...args.slice(0, -1)].join(' ')}\n\n${command}`,
        origin: 'user-terminal',
      },
    ])
    // The same launch as the agent's: absolute shell, hidden window, filtered environment.
    expect(path.isAbsolute(file)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      file,
      args,
      options: { cwd: sb.root, windowsHide: true, env: shellEnv(process.env) },
    })
    if (process.platform === 'win32') {
      expect(file.toLowerCase()).toMatch(/\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/)
      expect(args).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShell(powerShellScript(command)),
      ])
    }
    expect(h.audit.entries).toEqual([
      expect.objectContaining({
        tool: 'run_shell',
        args: { command, cwd: sb.root, timeoutMs: 60_000 },
        approval: 'approved',
        origin: 'user-terminal',
        outcome: 'ok',
      }),
    ])
    const output = `exit code: 0\ncwd: ${sb.root}\n--- stdout ---\nhello\n\n--- stderr ---\n`
    expect(events).toEqual([
      { type: 'command_started', runId: 'id-1', id: 'id-2', command, cwd: sb.root },
      { type: 'approval_closed', approvalId: 'id-3', approved: true },
      expect.objectContaining({ type: 'history_changed' }),
      { type: 'tool_result', runId: 'id-1', id: 'id-2', content: output, isError: false },
      { type: 'run_finished', runId: 'id-1', stopReason: 'end_turn' },
    ])
    // Saved in the conversation, and shown as a card when it is opened again.
    expect(toTranscript(store.saved())).toEqual([
      {
        kind: 'tool',
        id: 'id-2',
        name: 'run_shell',
        input: { command, cwd: sb.root },
        result: { content: output, isError: false },
        origin: 'user-terminal',
      },
    ])
  })

  it('runs nothing when the user denies it, and audits the denial', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const { h, session, events } = commandSession({ spawn }, () => false)
    await session.runCommand('echo nope', sb.root)
    await settled(session)
    expect(calls).toHaveLength(0)
    expect(h.audit.entries).toEqual([
      expect.objectContaining({ approval: 'denied', origin: 'user-terminal', error: 'declined' }),
    ])
    expect(commandResult(events)).toMatchObject({ isError: true })
    expect(commandResult(events)?.content).toMatch(/Nothing was run/)
  })

  it('refuses a cwd outside the grants without asking or running anything', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const { h, session, prompts, events } = commandSession({ spawn })
    await session.runCommand('echo hi', sb.outside)
    await settled(session)
    expect(prompts).toEqual([])
    expect(calls).toHaveLength(0)
    expect(h.audit.entries).toEqual([
      expect.objectContaining({ error: 'access-denied', origin: 'user-terminal' }),
    ])
    expect(commandResult(events)).toMatchObject({ isError: true })
    expect(commandResult(events)?.content).toMatch(/Access denied/)
  })

  it('is refused while an approval is pending, and refuses replies meanwhile', async () => {
    const { spawn, calls } = fakeSpawner((child) => {
      child.exit(0)
    })
    const { session, prompts } = commandSession({ spawn }, () => null)
    await session.runCommand('echo one', sb.root)
    await until(() => prompts.length > 0)
    expect(prompts).toHaveLength(1)
    expect(await session.runCommand('echo two', sb.root)).toMatchObject({ ok: false, code: 'busy' })
    expect(await session.send('hello')).toMatchObject({ ok: false, code: 'busy' })
    expect(prompts).toHaveLength(1)
    await session.stop()
    expect(calls).toHaveLength(0)
  })

  it('is refused while a reply is running', async () => {
    let finish: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { session } = commandSession({}, () => true, blocked)
    expect(await session.send('hello')).toEqual({ ok: true })
    expect(await session.runCommand('echo hi', sb.root)).toMatchObject({ ok: false, code: 'busy' })
    finish()
    await settled(session)
  })

  it('stop() cancels a running command and kills its process tree', async () => {
    const { spawn, calls } = fakeSpawner(() => {
      // Runs until killed.
    })
    const killTree = vi.fn((child: ShellProcess) => {
      ;(child as FakeProcess).exit(null, 'SIGKILL')
      return okKill()
    })
    const { h, session, events } = commandSession({ spawn, killTree })
    await session.runCommand('sleep 60', sb.root)
    await until(() => calls.length > 0)
    expect(calls).toHaveLength(1)
    await session.stop()
    expect(killTree).toHaveBeenCalledWith(calls[0]?.child)
    expect(commandResult(events)).toMatchObject({ isError: true })
    expect(commandResult(events)?.content).toMatch(/Cancelled; the process tree was killed/)
    expect(h.audit.entries).toEqual([
      expect.objectContaining({ origin: 'user-terminal', error: 'cancelled' }),
    ])
  })

  it('rejects empty commands and folders without running anything', async () => {
    const { session, prompts } = commandSession({})
    expect(await session.runCommand('  ', sb.root)).toMatchObject({ code: 'invalid_request' })
    expect(await session.runCommand('echo', '')).toMatchObject({ code: 'invalid_request' })
    expect(await session.runCommand(42, sb.root)).toMatchObject({ code: 'invalid_request' })
    expect(prompts).toEqual([])
  })

  it(
    'runs through the real shell (Windows PowerShell on Windows)',
    { timeout: 120_000 },
    async () => {
      const { session, events, h } = commandSession({})
      const command = process.platform === 'win32' ? 'Write-Output "typed-$(1+1)"' : 'echo typed-2'
      await session.runCommand(command, sb.root)
      await settled(session)
      expect(commandResult(events)).toMatchObject({ isError: false })
      expect(commandResult(events)?.content).toMatch(/^exit code: 0[\s\S]*typed-2/)
      expect(h.audit.entries[0]).toMatchObject({ origin: 'user-terminal', outcome: 'ok' })
      await fs.rm(sb.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    },
  )
})
