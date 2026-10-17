// Helpers for tests that start real processes. Not imported by app code.
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
)

export function isAlive(pid: number): boolean {
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

export async function waitUntil(check: () => boolean, ms: number, everyMs = 100): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return check()
}

/** The pids written one per line to `file`, or none yet. */
export function readPids(file: string): number[] {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

export async function waitForPid(file: string, ms: number): Promise<number> {
  await waitUntil(() => readPids(file).length > 0, ms)
  const pid = readPids(file)[0]
  if (pid === undefined) throw new Error(`no pid in ${file}`)
  return pid
}

/** Starts Windows PowerShell outside any sandbox, so it never holds a sandbox open. */
function startPowerShell(script: string): ChildProcess {
  return nodeSpawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export interface Pinned {
  pids: number[]
  release: () => void
}

export const unpinned: Pinned = { pids: [], release: () => undefined }

/**
 * Windows hands a freed pid to the next new process almost at once, so on a busy runner
 * `isAlive(pid)` can report an unrelated process. Holding an open handle to each process
 * keeps its pid reserved (and reported as exited once it dies) until `release`.
 */
export function pinProcesses(pids: number[], ms: number): Promise<Pinned> {
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

/** Kills whichever pinned processes are still running, then releases them. */
export async function cleanUp(pinned: Pinned): Promise<void> {
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
