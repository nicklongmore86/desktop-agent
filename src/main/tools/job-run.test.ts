// The real job-run.exe (native/job-run), on the Windows CI runner. `pnpm build:helpers` must
// have built it first: on Windows these tests fail rather than skip without it.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fakeContext, makeSandbox, type Sandbox } from '../permissions/test-support'
import { parseJobReport, verifyJobLauncher } from './job-launcher'
import {
  cleanUp,
  isAlive,
  pinProcesses,
  readPids,
  unpinned,
  waitForPid,
  waitUntil,
  type Pinned,
} from './process-test-support'
import { shellInvocation, type ShellSpawner } from './run-shell'
import { toolHarness } from './test-support'

const BUILD = path.resolve('build')
const LAUNCHER = path.join(BUILD, 'helpers', 'job-run.exe')
const PINS = path.join(BUILD, 'job-helper-pins.json')
const SHELL_MS = 120_000
const PING = '"$env:SystemRoot\\System32\\PING.EXE"'
// Starts a long-running ping in the same console and appends its pid to `file`.
const startPing = (file: string, extra = ' -NoNewWindow') =>
  `$g = Start-Process -FilePath ${PING} -ArgumentList '-n','300','127.0.0.1' -PassThru${extra}; ` +
  `Add-Content -Path '${file}' -Value $g.Id`

function pin(): string {
  const hash = (JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, { sha256?: string }>)[
    'helpers/job-run.exe'
  ]?.sha256
  if (!hash) throw new Error(`no pin in ${PINS}`)
  return hash
}

describe.runIf(process.platform === 'win32')('job-run.exe', () => {
  let sb: Sandbox

  beforeAll(async () => {
    if (!existsSync(LAUNCHER) || !existsSync(PINS)) {
      throw new Error('job-run.exe is not built: run `pnpm build:helpers` first')
    }
    // Pay PowerShell's first-run module indexing once, outside the tests' budgets.
    const warm = await makeSandbox()
    try {
      const r = await toolHarness(warm, { jobLauncher: launcherIn(BUILD) })
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

  beforeEach(async () => {
    sb = await makeSandbox()
  })

  afterEach(async () => {
    await fs.rm(sb.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }, 30_000)

  /** The launcher under `resources`\helpers, verified against the build's pin. */
  function launcherIn(resources: string) {
    return () =>
      verifyJobLauncher({ resources, sha256: pin(), grantedRoots: () => [], platform: 'win32' })
  }

  const harness = (overrides: Parameters<typeof toolHarness>[1] = {}) =>
    toolHarness(sb, { jobLauncher: launcherIn(BUILD), ...overrides })

  const run = (command: string, timeoutMs?: number) =>
    harness()
      .tool('run_shell')
      .execute(
        { command, cwd: sb.root, ...(timeoutMs ? { timeoutMs } : {}) },
        fakeContext(true).ctx,
      )

  it('passes the exit code through, and runs in a job', { timeout: SHELL_MS }, async () => {
    for (const code of [0, 7, 300]) {
      const r = await run(
        `$inJob = $false; Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessInJob(System.IntPtr p, System.IntPtr j, out bool r);'; ` +
          `$null = [W.K]::IsProcessInJob([System.Diagnostics.Process]::GetCurrentProcess().Handle, [IntPtr]::Zero, [ref]$inJob); ` +
          `Write-Output "in job: $inJob"; exit ${String(code)}`,
      )
      expect(r.content).toMatch(new RegExp(`^exit code: ${String(code)}\\ncwd: `))
      expect(r.content).toContain('in job: True')
      expect(r.content).not.toContain('Not run in a Job Object')
    }
  })

  const nonAscii = 'café Ünïcödé 日本語 中文 한국어 😀'

  it('keeps UTF-8 output and decodes CLIXML stderr', { timeout: SHELL_MS }, async () => {
    const r = await run(
      `Write-Output '${nonAscii}'; [Console]::Error.WriteLine('err ${nonAscii}')\n` +
        `Write-Progress -Activity ('bu' + 'sy') -Status x\nWrite-Warning 'careful <&>'\n` +
        `Write-Error 'bad café 日本語 😀'\nexit 2`,
    )
    const content = r.content.replaceAll('\r\n', '\n')
    expect(content).toMatch(/^exit code: 2\n/)
    expect(content).toContain(`--- stdout ---\n${nonAscii}\n`)
    expect(content).toContain(`--- stderr ---\nerr ${nonAscii}\n`)
    expect(content).toMatch(/WARNING: careful <&>\n/)
    expect(content).toContain('bad café 日本語 😀')
    expect(content).not.toContain('\uFFFD')
    expect(content).not.toMatch(/CLIXML|<Objs|<S S=|_x[0-9A-F]{4}_|busy/)
  })

  it(
    'stops and counts the background processes a command leaves running',
    { timeout: SHELL_MS },
    async () => {
      const list = path.join(sb.root, 'bg.pid')
      // Two console programs sharing the console, one in a console window of its own.
      const r = await run(
        `${startPing(list)}; ${startPing(list)}; ${startPing(list, ' -WindowStyle Hidden')}; exit 0`,
      )
      expect(r.content).toMatch(
        /^exit code: 0\n3 background processes were stopped when the command finished\.\ncwd: /,
      )
      const pids = readPids(list)
      expect(pids).toHaveLength(3)
      expect(await waitUntil(() => !pids.some(isAlive), 2000, 20)).toBe(true)
    },
  )

  it('reports no background processes when there are none', { timeout: SHELL_MS }, async () => {
    const r = await run(`& ${PING} -n 1 127.0.0.1 | Out-Null; Write-Output done`)
    expect(r.content).toMatch(/^exit code: 0\ncwd: /)
    expect(r.content).toContain('done')
  })

  it('cannot be fooled by report lines in the command output', { timeout: SHELL_MS }, async () => {
    const list = path.join(sb.root, 'bg.pid')
    const spoof = 'job-run:1 exit=0 background=99'
    const r = await run(
      `${startPing(list)}; Write-Output '${spoof}'; [Console]::Error.WriteLine('${spoof}'); ` +
        `[Console]::Out.Write("job-run:1 error=CreateProcess code=5\`n"); exit 4`,
    )
    expect(r.isError).toBeUndefined()
    expect(r.content).toMatch(
      /^exit code: 4\n1 background process was stopped when the command finished\.\ncwd: /,
    )
    expect(r.content).not.toContain('99 background')
  })

  it('denies breaking away from the job', { timeout: SHELL_MS }, async () => {
    const r = await run(
      `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Breakaway {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string r, d, t; public int x, y, w, h, cx, cy, fill, flags; public short show, cb2; public IntPtr r2, i, o, e; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  public static int Try(string exe) {
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si);
    PROCESS_INFORMATION pi;
    // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW
    if (CreateProcessW(exe, new StringBuilder("ping -n 2 127.0.0.1"), IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, null, ref si, out pi)) return 0;
    return Marshal.GetLastWin32Error();
  }
}
'@
Write-Output ("breakaway: " + [Breakaway]::Try("$env:SystemRoot\\System32\\PING.EXE"))`,
    )
    expect(r.content).toMatch(/^exit code: 0/)
    // ERROR_ACCESS_DENIED: the job does not allow breakaway.
    expect(r.content).toContain('breakaway: 5')
  })

  async function orphanTree(): Promise<{ grandchild: number; pinned: Pinned }> {
    const list = path.join(sb.root, 'grandchild.pid')
    const childDone = path.join(sb.root, 'child.done')
    await waitForPid(list, 60_000)
    const grandchild = readPids(list)[0] ?? 0
    // Its parent (the middle PowerShell) has exited: an orphan, outside any tree walk.
    expect(await waitUntil(() => existsSync(childDone), 60_000)).toBe(true)
    return { grandchild, pinned: await pinProcesses([grandchild], 60_000) }
  }

  // The shell starts a PowerShell that starts a ping and exits at once.
  const orphanCommand = (root: string) =>
    `$c = Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ` +
    `-ArgumentList '-NoProfile','-NonInteractive','-Command',` +
    // Start-Process joins the arguments with spaces; the inner PowerShell re-reads them.
    `'${startPing(path.join(root, 'grandchild.pid')).replaceAll("'", "''").replaceAll('"', '\\"')}' ` +
    `-PassThru -NoNewWindow; $c.WaitForExit(); Set-Content -Path '${path.join(root, 'child.done')}' -Value 1; ` +
    'Start-Sleep 300'

  it('kills an orphaned grandchild within 1 s of a cancel', { timeout: SHELL_MS }, async () => {
    const h = harness()
    const { ctx, controller } = fakeContext(true)
    const running = h
      .tool('run_shell')
      .execute({ command: orphanCommand(sb.root), cwd: sb.root, timeoutMs: 300_000 }, ctx)
    let pinned = unpinned
    try {
      const tree = await orphanTree()
      pinned = tree.pinned
      expect(isAlive(tree.grandchild)).toBe(true)
      const cancelled = Date.now()
      controller.abort()
      expect(await waitUntil(() => !isAlive(tree.grandchild), 1000, 10)).toBe(true)
      expect(Date.now() - cancelled).toBeLessThan(1000)
      expect(await running).toMatchObject({
        isError: true,
        content: expect.stringMatching(/^Cancelled; the process tree was killed/) as unknown,
      })
    } finally {
      controller.abort()
      await running
      await cleanUp(pinned)
    }
  })

  it(
    'kills every process, including those started every 50 ms while it is cancelled',
    { timeout: SHELL_MS },
    async () => {
      const list = path.join(sb.root, 'spawned.pid')
      const h = harness()
      const { ctx, controller } = fakeContext(true)
      const running = h.tool('run_shell').execute(
        {
          command: `while ($true) { ${startPing(list)}; Start-Sleep -Milliseconds 50 }`,
          cwd: sb.root,
          timeoutMs: 300_000,
        },
        ctx,
      )
      let pinned = unpinned
      try {
        expect(await waitUntil(() => readPids(list).length >= 5, 60_000)).toBe(true)
        pinned = await pinProcesses(readPids(list), 60_000)
        controller.abort()
        expect(await running).toMatchObject({
          isError: true,
          content: expect.stringMatching(/^Cancelled; the process tree was killed/) as unknown,
        })
        const all = readPids(list)
        expect(all.length).toBeGreaterThanOrEqual(pinned.pids.length)
        expect(await waitUntil(() => !all.some(isAlive), 1000, 10)).toBe(true)
      } finally {
        controller.abort()
        await running
        await cleanUp(pinned)
      }
    },
  )

  // job-run.exe started the way the app starts it, by a stand-in for the app.
  function startUnderFakeApp(command: string): ReturnType<typeof nodeSpawn> {
    const { file, args } = shellInvocation(command, 'win32', process.env)
    const script =
      `const c = require('node:child_process').spawn(${JSON.stringify(LAUNCHER)}, ` +
      `['--parent', String(process.pid), '--', ${JSON.stringify(file)}, ...${JSON.stringify(args)}], ` +
      `{ cwd: ${JSON.stringify(sb.root)}, stdio: 'ignore', windowsHide: true }); ` +
      `console.log(c.pid); setInterval(() => {}, 1000)`
    return nodeSpawn(process.execPath, ['-e', script], {
      cwd: sb.root,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    })
  }

  for (const victim of ['app', 'job-run.exe'] as const) {
    it(
      `kills the orphaned grandchild when the ${victim} is killed outright`,
      { timeout: SHELL_MS },
      async () => {
        const app = startUnderFakeApp(orphanCommand(sb.root))
        let launcher = 0
        app.stdout?.on('data', (chunk: Buffer) => {
          launcher ||= Number.parseInt(chunk.toString(), 10)
        })
        let pinned = unpinned
        try {
          const tree = await orphanTree()
          pinned = tree.pinned
          expect(isAlive(tree.grandchild)).toBe(true)
          expect(launcher).toBeGreaterThan(0)
          if (victim === 'app') app.kill('SIGKILL')
          else process.kill(launcher, 'SIGKILL')
          expect(await waitUntil(() => !isAlive(tree.grandchild), 2000, 10)).toBe(true)
        } finally {
          app.kill('SIGKILL')
          await cleanUp(pinned)
        }
      },
    )
  }

  it(
    'refuses to run when the parent is not the process it claims',
    { timeout: SHELL_MS },
    async () => {
      const marker = path.join(sb.root, 'ran.txt')
      const { file, args } = shellInvocation(
        `Set-Content -Path '${marker}' -Value 1`,
        'win32',
        process.env,
      )
      const child = nodeSpawn(
        LAUNCHER,
        ['--parent', String(process.pid), '--parent-start', '1', '--', file, ...args],
        { cwd: sb.root, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      let report = ''
      child.stdio[3]?.on('data', (chunk: Buffer) => (report += chunk.toString()))
      child.stdout?.resume()
      child.stderr?.resume()
      const code = await new Promise((resolve) => child.once('close', resolve))
      expect(parseJobReport(report)).toEqual({ kind: 'error', step: 'parent', code: 0 })
      expect(code).toBe(0x4a520003)
      expect(existsSync(marker)).toBe(false)
    },
  )

  it(
    'falls back, saying why, when the launcher fails its integrity check',
    { timeout: SHELL_MS },
    async () => {
      const resources = path.join(sb.base, 'resources')
      await fs.mkdir(path.join(resources, 'helpers'), { recursive: true })
      const copy = path.join(resources, 'helpers', 'job-run.exe')
      await fs.copyFile(LAUNCHER, copy)
      await fs.appendFile(copy, Buffer.from([0]))
      const started: string[] = []
      const spawn: ShellSpawner = (file, args, options) => {
        started.push(file)
        return nodeSpawn(file, args, options)
      }
      const r = await toolHarness(sb, { spawn, jobLauncher: launcherIn(resources) })
        .tool('run_shell')
        .execute({ command: 'Write-Output fallback-ok', cwd: sb.root }, fakeContext(true).ctx)
      expect(r.content).toMatch(/^exit code: 0\ncwd: /)
      expect(r.content).toContain('fallback-ok')
      expect(r.content).toMatch(
        /\nNot run in a Job Object \(job-run.exe failed its integrity check\); processes the command started may still be running\.$/,
      )
      expect(started).toEqual([shellInvocation('x', 'win32', process.env).file])
    },
  )
})

// The installed layout, in the installer CI job: the packaged launcher matches the pin and runs.
describe.runIf(process.env.DESKTOP_TEST_RESOURCES)('packaged job-run.exe', () => {
  const resources = process.env.DESKTOP_TEST_RESOURCES ?? ''

  it(
    'is present at resources\\helpers, pinned, and runs a command',
    { timeout: SHELL_MS },
    async () => {
      const jobLauncher = () =>
        verifyJobLauncher({ resources, sha256: pin(), grantedRoots: () => [], platform: 'win32' })
      expect(await jobLauncher()).toMatchObject({ ok: true })
      const sb = await makeSandbox()
      try {
        const r = await toolHarness(sb, { jobLauncher })
          .tool('run_shell')
          .execute(
            { command: 'Write-Output packaged-ok; exit 3', cwd: sb.root, timeoutMs: 240_000 },
            fakeContext(true).ctx,
          )
        expect(r.content).toMatch(/^exit code: 3\ncwd: /)
        expect(r.content).toContain('packaged-ok')
      } finally {
        await fs.rm(sb.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    },
  )
})
