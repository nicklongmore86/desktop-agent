import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import pinsJson from './runtime-pins.json'
import {
  bundledRuntimeCandidates,
  CLAUDE_VERSION,
  CODEX_VERSION,
  discoverRuntime,
  runtimeCandidates,
  runtimeEnv,
  RUNTIME_PINS,
  supportedVersion,
  type RuntimeName,
  type RuntimePins,
} from './runtime'

const windows = process.platform === 'win32'
const exe = windows ? '.exe' : ''
const target = `${process.platform}-${process.arch}`
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )
})
async function fixture() {
  // Canonical root: discovery returns realpaths (/var on macOS, 8.3 names on Windows).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'Runtime discovery with spaces ')))
  roots.push(root)
  return root
}

// A real executable on every platform: it records each run in `<self>.ran` and prints
// `<self>.version`. Windows uses a tiny .NET Framework program (csc.exe ships with Windows)
// because shell:false discovery cannot run scripts or .cmd shims there.
let template = ''
let templateRoot = ''
beforeAll(async () => {
  templateRoot = await realpath(await mkdtemp(join(tmpdir(), 'fake-runtime-')))
  if (!windows) {
    template = join(templateRoot, 'fake')
    await writeFile(template, '#!/bin/sh\necho ran >> "$0.ran"\ncat "$0.version"\n')
    return
  }
  const source = join(templateRoot, 'fake.cs')
  await writeFile(
    source,
    `using System; using System.IO; using System.Reflection;
static class Fake {
  static int Main() {
    string self = Assembly.GetEntryAssembly().Location;
    File.AppendAllText(self + ".ran", "ran\\n");
    Console.WriteLine(File.ReadAllText(self + ".version").Trim());
    return 0;
  }
}`,
  )
  template = join(templateRoot, 'fake.exe')
  const csc = join(
    process.env['WINDIR'] ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  )
  await promisify(execFile)(csc, ['/nologo', '/target:exe', `/out:${template}`, source])
}, 60000)
afterAll(async () => {
  await rm(templateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function executable(path: string, version: string) {
  await mkdir(dirname(path), { recursive: true })
  await copyFile(template, path)
  await chmod(path, 0o755)
  await writeFile(path + '.version', version)
}
const ran = (path: string) =>
  access(path + '.ran').then(
    () => true,
    () => false,
  )
const sha = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

/** A packaged resources directory with digests pinned for this test target only. */
async function packaged(root: string, name: RuntimeName) {
  const resources = join(root, 'resources')
  const relative =
    name === 'claude' ? `app.asar.unpacked/claude${exe}` : `runtimes/codex/bin/codex${exe}`
  const companion = `runtimes/codex/codex-resources/codex-command-runner${exe}`
  const file = join(resources, relative)
  await executable(file, name === 'claude' ? CLAUDE_VERSION : CODEX_VERSION)
  const files: Record<string, string> = { [relative]: await sha(file) }
  if (name === 'codex') {
    await executable(join(resources, companion), 'companion')
    files[companion] = await sha(join(resources, companion))
  }
  const manifest = {
    claude: name === 'claude' ? { path: relative, sha256: files[relative] } : {},
    files: Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => path.startsWith('runtimes/'))
        .map(([path, hash]) => [path.slice('runtimes/'.length), hash]),
    ),
  }
  await mkdir(join(resources, 'runtimes'), { recursive: true })
  await writeFile(join(resources, 'runtimes', 'integrity.json'), JSON.stringify(manifest))
  const pins: RuntimePins = { [target]: { [name]: { executable: relative, files } } }
  // A compatible external copy that packaged discovery must never fall back to.
  const external = join(root, 'external', name + exe)
  await executable(external, name === 'claude' ? CLAUDE_VERSION : CODEX_VERSION)
  const options = {
    home: join(root, 'home'),
    cwd: root,
    env: runtimeEnv(),
    resourcesPath: resources,
    pins,
  }
  return {
    file,
    companion: join(resources, companion),
    external,
    source: { PATH: dirname(external) },
    options,
  }
}

it('development discovery skips old external versions and reports all incompatible paths', async () => {
  const home = await fixture()
  const old = join(home, '.local', 'bin', 'claude' + exe)
  const current = join(home, 'current', 'claude' + exe)
  await executable(old, '2.1.1')
  await executable(current, '2.1.299 (Claude Code)')
  const options = { home, development: false, env: runtimeEnv() }
  const source = { PATH: join(home, 'current') }
  expect(await discoverRuntime('claude', source, options)).toBe(current)
  await writeFile(current + '.version', '2.1.300')
  await expect(discoverRuntime('claude', source, options)).rejects.toThrow(old + ': 2.1.1')
  await expect(discoverRuntime('claude', source, options)).rejects.toThrow(current + ': 2.1.300')
})

it('development discovery probes one executable reached through several paths once', async () => {
  const home = await fixture()
  const real = join(home, 'real', 'claude' + exe)
  await executable(real, '2.1.1')
  // A junction needs no symlink privilege on Windows; elsewhere it is a directory symlink.
  await symlink(join(home, 'real'), join(home, 'linked'), 'junction')
  const PATH = [join(home, 'real'), join(home, 'linked')].join(windows ? ';' : delimiter)
  const error = await discoverRuntime(
    'claude',
    { PATH },
    { home, development: false, env: runtimeEnv() },
  ).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message.split(real).length - 1).toBe(1)
  expect((await readFile(real + '.ran', 'utf8')).trim().split('\n')).toHaveLength(1)
})

it('development discovery reads PATH case-insensitively', async () => {
  const home = await fixture()
  const current = join(home, 'current', 'codex' + exe)
  await executable(current, `codex-cli ${CODEX_VERSION}`)
  expect(
    await discoverRuntime(
      'codex',
      { Path: join(home, 'current') },
      { home, development: false, env: runtimeEnv() },
    ),
  ).toBe(current)
})

it.each(['claude', 'codex'] as const)(
  'packaged discovery runs a verified bundled %s and never an external copy',
  async (name) => {
    const f = await packaged(await fixture(), name)
    expect(await discoverRuntime(name, f.source, f.options)).toBe(f.file)
    expect(await ran(f.file)).toBe(true)
    expect(await ran(f.external)).toBe(false)
  },
)

it('packaged discovery refuses a tampered bundled executable without running it', async () => {
  const f = await packaged(await fixture(), 'codex')
  // Verified once (and cached); a later change must still be detected.
  expect(await discoverRuntime('codex', f.source, f.options)).toBe(f.file)
  await rm(f.file + '.ran')
  await appendFile(f.file, 'tampered')
  await expect(discoverRuntime('codex', f.source, f.options)).rejects.toThrow(
    /Damaged runtime: bundled codex failed integrity verification \(runtimes\/codex\/bin\/codex.*Repair or reinstall Desktop Agent/,
  )
  expect(await ran(f.file)).toBe(false)
  expect(await ran(f.external)).toBe(false)
})

it('packaged discovery refuses a tampered Codex companion without running Codex', async () => {
  const f = await packaged(await fixture(), 'codex')
  await appendFile(f.companion, 'tampered')
  await expect(discoverRuntime('codex', f.source, f.options)).rejects.toThrow(
    'codex-command-runner',
  )
  expect(await ran(f.file)).toBe(false)
  expect(await ran(f.companion)).toBe(false)
  expect(await ran(f.external)).toBe(false)
})

it('packaged discovery refuses a manifest that disagrees with the compiled-in pins', async () => {
  const f = await packaged(await fixture(), 'claude')
  const manifest = join(f.options.resourcesPath, 'runtimes', 'integrity.json')
  await writeFile(manifest, JSON.stringify({ claude: {}, files: {} }))
  await expect(discoverRuntime('claude', f.source, f.options)).rejects.toThrow(
    'failed integrity verification',
  )
  await rm(manifest)
  await expect(discoverRuntime('claude', f.source, f.options)).rejects.toThrow(
    'integrity manifest is missing',
  )
  expect(await ran(f.file)).toBe(false)
  expect(await ran(f.external)).toBe(false)
})

it('packaged discovery reports repair when the bundle is missing, even with a compatible PATH copy', async () => {
  const f = await packaged(await fixture(), 'claude')
  await rm(f.file)
  await expect(discoverRuntime('claude', f.source, f.options)).rejects.toThrow(
    /^Missing runtime: bundled claude 2\.1\.299 was not found\. Repair or reinstall Desktop Agent/,
  )
  // A target without any pinned bundle also never falls back to PATH.
  await expect(discoverRuntime('claude', f.source, { ...f.options, pins: {} })).rejects.toThrow(
    /^Missing runtime: no bundled claude.*Repair or reinstall Desktop Agent/,
  )
  expect(await ran(f.external)).toBe(false)
})

it('pins only Windows x64 bundles, at the paths packaging produces', () => {
  expect(Object.keys(RUNTIME_PINS)).toEqual(['win32-x64'])
  expect(pinsJson['win32-x64'].claude.version).toBe(CLAUDE_VERSION)
  expect(pinsJson['win32-x64'].codex.version).toBe(CODEX_VERSION)
  expect(bundledRuntimeCandidates('codex', 'R', 'win32', 'x64')).toEqual([
    join('R', 'runtimes', 'codex', 'bin', 'codex.exe'),
  ])
  expect(bundledRuntimeCandidates('claude', 'R', 'win32', 'x64')).toEqual([
    join(
      'R',
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk-win32-x64',
      'claude.exe',
    ),
  ])
  const codex = RUNTIME_PINS['win32-x64']?.codex?.files ?? {}
  for (const companion of [
    'runtimes/codex/bin/codex-code-mode-host.exe',
    'runtimes/codex/codex-path/rg.exe',
    'runtimes/codex/codex-resources/codex-command-runner.exe',
    'runtimes/codex/codex-resources/codex-windows-sandbox-setup.exe',
  ])
    expect(codex[companion]).toMatch(/^[0-9a-f]{64}$/)
})

it('matches architecture explicitly and includes nested npm optional dependencies', async () => {
  expect(bundledRuntimeCandidates('codex', '/resources', 'win32', 'arm64')).toEqual([])
  expect(bundledRuntimeCandidates('claude', '/resources', 'win32', 'ia32')).toEqual([])
  expect(bundledRuntimeCandidates('claude', '/resources', 'linux', 'x64')).toEqual([])
  expect(
    runtimeCandidates('codex', '/npm', 'win32', 'x64').some((path) =>
      path
        .replaceAll('\\', '/')
        .includes(
          'codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
        ),
    ),
  ).toBe(true)
  await expect(discoverRuntime('codex', {}, { arch: 'ia32' })).rejects.toThrow('architecture')
})
it('enforces exact pinned versions', () => {
  expect(supportedVersion('codex', 'codex-cli 0.162.1')).toBe(true)
  expect(supportedVersion('codex', 'codex-cli 0.162.10')).toBe(false)
  expect(supportedVersion('claude', '2.1.299 (Claude Code)')).toBe(true)
  expect(supportedVersion('claude', '2.1.300')).toBe(false)
})
