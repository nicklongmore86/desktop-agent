import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { defaultKillTree, defaultSpawner } from '../tools/run-shell'

export const CODEX_VERSION = '0.162.1'
export const CLAUDE_VERSION = '2.1.299'
export type RuntimeName = 'claude' | 'codex'

/** Deliberate allowlist: no API keys, alternate endpoints, preload code, or CLI overrides. */
export function runtimeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) =>
      /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LOCALAPPDATA|APPDATA|LANG|LC_ALL|COMSPEC)$/i.test(
        key,
      ),
    ),
  )
}

/** Never invoke cmd shims or interpolate a path into a shell command. */
export async function discoverRuntime(
  name: RuntimeName,
  source = process.env,
): Promise<string | null> {
  const home = homedir()
  const dirs = [
    join(home, '.local', 'bin'),
    ...(source['PATH'] ?? source['Path'] ?? '').split(delimiter),
  ]
  if (source['APPDATA']) dirs.push(join(source['APPDATA'], 'npm'))
  const candidates = dirs
    .filter(isAbsolute)
    .flatMap((dir) => runtimeCandidates(name, dir, process.platform, process.arch))
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return await realpath(candidate)
    } catch {
      /* Try next install location. */
    }
  }
  return null
}

/** Native npm layouts; Windows .cmd shims are intentionally never executed. */
export function runtimeCandidates(
  name: RuntimeName,
  dir: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const suffix = platform === 'win32' ? '.exe' : ''
  const candidates = [resolve(dir, name + suffix)]
  if (name === 'codex') {
    const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
    const target =
      platform === 'win32'
        ? `${cpu}-pc-windows-msvc`
        : platform === 'darwin'
          ? `${cpu}-apple-darwin`
          : `${cpu}-unknown-linux-musl`
    for (const root of [join(dir, 'node_modules'), resolve(dir, '..', 'lib', 'node_modules')]) {
      for (const pkg of ['codex', `codex-${platform}-${arch}`]) {
        for (const sub of ['bin', 'codex'])
          candidates.push(join(root, '@openai', pkg, 'vendor', target, sub, 'codex' + suffix))
      }
    }
  }
  return candidates
}

export async function providerDirectories(userData: string, name: RuntimeName) {
  const home = join(userData, 'providers', name)
  const cwd = join(home, 'empty-workspace')
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

export function launch(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(file, args, {
    cwd,
    env,
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
}

export async function killRuntime(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const kill = defaultKillTree(process.platform, defaultSpawner, runtimeEnv())
  await Promise.race([kill(child), new Promise<void>((resolve) => setTimeout(resolve, 2000))])
  child.kill('SIGKILL')
}

export async function capture(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeout = 10000,
): Promise<string> {
  signal?.throwIfAborted()
  const child = launch(file, args, cwd, env)
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      void killRuntime(child)
      if (error) reject(error)
      else resolve(output)
    }
    const abort = () => {
      finish(new Error('Operation cancelled.'))
    }
    const timer = setTimeout(() => {
      finish(new Error('Runtime timed out.'))
    }, timeout)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 1024 * 1024) finish(new Error('Runtime output exceeded limit.'))
    })
    child.stderr.resume()
    child.once('error', () => {
      finish(new Error('Runtime could not start.'))
    })
    child.once('close', (code) => {
      finish(
        code === 0
          ? undefined
          : new Error('Runtime command failed. Check installation and sign-in.'),
      )
    })
  })
}
