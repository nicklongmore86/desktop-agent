import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
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

export interface DiscoveryOptions {
  resourcesPath?: string
  platform?: NodeJS.Platform
  arch?: string
  home?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal | undefined
  /** Development dependencies; disabled when inspecting a packaged resource directory. */
  development?: boolean
}

export function bundledRuntimeCandidates(
  name: RuntimeName,
  resourcesPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (!['x64', 'arm64'].includes(arch) || !['win32', 'linux', 'darwin'].includes(platform))
    return []
  if (name === 'codex')
    return platform === 'win32' && arch === 'x64'
      ? [join(resourcesPath, 'runtimes', 'codex', 'bin', 'codex.exe')]
      : []
  return [
    join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      `claude-agent-sdk-${platform}-${arch}`,
      platform === 'win32' ? 'claude.exe' : 'claude',
    ),
  ]
}

export function supportedVersion(name: RuntimeName, output: string): boolean {
  const expected = name === 'claude' ? CLAUDE_VERSION : CODEX_VERSION
  return new RegExp(`(?:^|\\s)${expected.replaceAll('.', '\\.')}([\\s(]|$)`).test(output)
}

/** Prefer app-owned binaries; never invoke cmd shims or interpolate a shell command. */
export async function discoverRuntime(
  name: RuntimeName,
  source = process.env,
  options: DiscoveryOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (!['x64', 'arm64'].includes(arch) || !['win32', 'linux', 'darwin'].includes(platform))
    throw new Error(`Unsupported runtime architecture: ${platform}/${arch}.`)
  const home = options.home ?? homedir()
  const resources =
    options.resourcesPath ??
    (process.resourcesPath && existsSync(join(process.resourcesPath, 'app.asar'))
      ? process.resourcesPath
      : undefined)
  const owned = resources ? bundledRuntimeCandidates(name, resources, platform, arch) : []
  if (options.development ?? !resources) {
    const require = createRequire(import.meta.url)
    try {
      const pkg =
        name === 'claude'
          ? `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
          : `@openai/codex-${platform}-${arch}`
      const root = dirname(require.resolve(`${pkg}/package.json`))
      owned.push(
        name === 'claude'
          ? join(root, platform === 'win32' ? 'claude.exe' : 'claude')
          : join(
              root,
              'vendor',
              runtimeTarget(platform, arch),
              'bin',
              platform === 'win32' ? 'codex.exe' : 'codex',
            ),
      )
    } catch {
      /* Optional development dependency is not installed. */
    }
  }
  const dirs = [
    join(home, '.local', 'bin'),
    ...(source['PATH'] ?? source['Path'] ?? '').split(platform === 'win32' ? ';' : delimiter),
  ]
  if (source['APPDATA']) dirs.push(join(source['APPDATA'], 'npm'))
  const candidates = [
    ...owned,
    ...dirs.filter(isAbsolute).flatMap((dir) => runtimeCandidates(name, dir, platform, arch)),
  ]
  const detected: string[] = []
  for (const candidate of new Set(candidates)) {
    options.signal?.throwIfAborted()
    let file: string
    try {
      await access(candidate)
      file = await realpath(candidate)
    } catch {
      continue
    }
    try {
      const version = await capture(
        file,
        ['--version'],
        options.cwd ?? home,
        options.env ?? runtimeEnv(source),
        options.signal,
      )
      if (supportedVersion(name, version)) return file
      detected.push(`${file}: ${version.trim().slice(0, 160)}`)
    } catch {
      options.signal?.throwIfAborted()
      detected.push(`${file}: could not read version`)
    }
  }
  if (detected.length)
    throw new Error(
      `Unsupported ${name} runtime. Expected ${name === 'claude' ? CLAUDE_VERSION : CODEX_VERSION}. Detected ${detected.join('; ')}. Repair or reinstall Desktop Agent to restore bundled runtimes.`,
    )
  return null
}

function runtimeTarget(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  return platform === 'win32'
    ? `${cpu}-pc-windows-msvc`
    : platform === 'darwin'
      ? `${cpu}-apple-darwin`
      : `${cpu}-unknown-linux-musl`
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
    if (!['x64', 'arm64'].includes(arch)) return []
    const target = runtimeTarget(platform, arch)
    for (const root of [join(dir, 'node_modules'), resolve(dir, '..', 'lib', 'node_modules')]) {
      for (const pkg of [
        'codex',
        `codex-${platform}-${arch}`,
        `codex/node_modules/@openai/codex-${platform}-${arch}`,
      ]) {
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
