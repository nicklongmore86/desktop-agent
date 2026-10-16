import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { access, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { defaultKillTree, defaultSpawner } from '../tools/run-shell'
import pins from './runtime-pins.json'

export const CODEX_VERSION = '0.162.1'
export const CLAUDE_VERSION = '2.1.299'
export type RuntimeName = 'claude' | 'codex'

/** One bundled runtime: its executable and every file it may load, relative to resources. */
export interface PinnedRuntime {
  executable: string
  files: Record<string, string>
}
/** Keyed by `${platform}-${arch}`; a target without an entry has no bundled runtime. */
export type RuntimePins = Partial<Record<string, Partial<Record<RuntimeName, PinnedRuntime>>>>
/** SHA-256 digests compiled into the app, derived from the official pinned releases. */
export const RUNTIME_PINS: RuntimePins = pins

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
  /** Overrides the compiled-in digests (tests only). */
  pins?: RuntimePins
}

function bundledPin(
  name: RuntimeName,
  platform: NodeJS.Platform,
  arch: string,
  runtimePins: RuntimePins,
): PinnedRuntime | undefined {
  return runtimePins[`${platform}-${arch}`]?.[name]
}

export function bundledRuntimeCandidates(
  name: RuntimeName,
  resourcesPath: string,
  platform: NodeJS.Platform,
  arch: string,
  runtimePins: RuntimePins = RUNTIME_PINS,
): string[] {
  const pin = bundledPin(name, platform, arch, runtimePins)
  return pin ? [join(resourcesPath, ...pin.executable.split('/'))] : []
}

export function supportedVersion(name: RuntimeName, output: string): boolean {
  const expected = name === 'claude' ? CLAUDE_VERSION : CODEX_VERSION
  return new RegExp(`(?:^|\\s)${expected.replaceAll('.', '\\.')}([\\s(]|$)`).test(output)
}

function expectedVersion(name: RuntimeName): string {
  return name === 'claude' ? CLAUDE_VERSION : CODEX_VERSION
}

function repair(message: string): Error {
  return new Error(`${message} Repair or reinstall Desktop Agent to restore bundled runtimes.`)
}

const digests = new Map<string, Promise<string>>()
/** Streamed SHA-256, cached for the process lifetime by path, size and modification time. */
async function fileDigest(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`)
  const key = [path, info.size, info.mtimeMs, info.ino].join('\0')
  let digest = digests.get(key)
  if (!digest) {
    digest = (async () => {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
      return hash.digest('hex')
    })()
    digests.set(key, digest)
    digest.catch(() => digests.delete(key))
  }
  return digest
}

/** The build manifest (resources/runtimes/integrity.json) must agree with the compiled-in pin. */
function manifestDigest(manifest: unknown, path: string): unknown {
  const record = (value: unknown) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const root = record(manifest)
  if (path.startsWith('runtimes/')) return record(root['files'])[path.slice('runtimes/'.length)]
  const claude = record(root['claude'])
  return claude['path'] === path ? claude['sha256'] : undefined
}

/**
 * Packaged builds run only the bundled runtime, and only after every pinned file
 * (the executable and the companions it launches) matches its compiled-in digest.
 */
async function verifiedBundle(
  name: RuntimeName,
  resources: string,
  pin: PinnedRuntime,
  signal?: AbortSignal,
): Promise<string> {
  const executable = join(resources, ...pin.executable.split('/'))
  try {
    await access(executable)
  } catch {
    throw repair(`Missing runtime: bundled ${name} ${expectedVersion(name)} was not found.`)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(resources, 'runtimes', 'integrity.json'), 'utf8'))
  } catch {
    throw repair(`Damaged runtime: the bundled ${name} integrity manifest is missing or invalid.`)
  }
  const results = await Promise.all(
    Object.entries(pin.files).map(async ([path, expected]) => {
      if (manifestDigest(manifest, path) !== expected) return path
      try {
        return (await fileDigest(join(resources, ...path.split('/')))) === expected ? null : path
      } catch {
        return path
      }
    }),
  )
  signal?.throwIfAborted()
  const failed = results.filter((path) => path !== null)
  if (failed.length)
    throw repair(
      `Damaged runtime: bundled ${name} failed integrity verification (${failed.slice(0, 3).join(', ')}).`,
    )
  return await realpath(executable)
}

/**
 * Packaged builds use only verified app-owned binaries. Development builds may use
 * pinned development dependencies or PATH; neither ever invokes cmd shims or a shell.
 */
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
  const cwd = options.cwd ?? home
  const env = options.env ?? runtimeEnv(source)
  const resources =
    options.resourcesPath ??
    (process.resourcesPath && existsSync(join(process.resourcesPath, 'app.asar'))
      ? process.resourcesPath
      : undefined)
  if (resources) {
    // No PATH fallback: packaging (scripts/runtime-bundle.mjs) only produces targets with
    // pinned bundles, so an external CLI would only ever replace a missing or tampered one.
    const pin = bundledPin(name, platform, arch, options.pins ?? RUNTIME_PINS)
    if (!pin) throw repair(`Missing runtime: no bundled ${name} for ${platform}/${arch}.`)
    const file = await verifiedBundle(name, resources, pin, options.signal)
    let version: string
    try {
      version = await capture(file, ['--version'], cwd, env, options.signal)
    } catch {
      options.signal?.throwIfAborted()
      throw repair(`Damaged runtime: bundled ${name} could not start.`)
    }
    if (!supportedVersion(name, version))
      throw repair(
        `Unsupported ${name} runtime. Expected ${expectedVersion(name)}. Detected ${file}: ${version.trim().slice(0, 160)}.`,
      )
    return file
  }
  const owned: string[] = []
  if (options.development ?? true) {
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
  // Environment names are case-insensitive on Windows (PATH, Path, path).
  const path =
    source['PATH'] ??
    Object.entries(source).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ??
    ''
  const dirs = [join(home, '.local', 'bin'), ...path.split(platform === 'win32' ? ';' : delimiter)]
  if (source['APPDATA']) dirs.push(join(source['APPDATA'], 'npm'))
  const candidates = [
    ...owned,
    ...dirs.filter(isAbsolute).flatMap((dir) => runtimeCandidates(name, dir, platform, arch)),
  ]
  const detected: string[] = []
  // Canonical paths: realpath resolves npm symlinks and expands Windows 8.3 short
  // names, so one executable reached through several spellings is probed once.
  const seen = new Set<string>()
  for (const candidate of new Set(candidates)) {
    options.signal?.throwIfAborted()
    let file: string
    try {
      await access(candidate)
      file = await realpath(candidate)
    } catch {
      continue
    }
    if (seen.has(file)) continue
    seen.add(file)
    try {
      const version = await capture(file, ['--version'], cwd, env, options.signal)
      if (supportedVersion(name, version)) return file
      detected.push(`${file}: ${version.trim().slice(0, 160)}`)
    } catch {
      options.signal?.throwIfAborted()
      detected.push(`${file}: could not read version`)
    }
  }
  if (detected.length)
    throw new Error(
      `Unsupported ${name} runtime. Expected ${expectedVersion(name)}. Detected ${detected.join('; ')}. Install the pinned version for development.`,
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
  acceptedExitCodes: readonly number[] = [0],
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
        code !== null && acceptedExitCodes.includes(code)
          ? undefined
          : new Error('Runtime command failed. Check installation and sign-in.'),
      )
    })
  })
}
