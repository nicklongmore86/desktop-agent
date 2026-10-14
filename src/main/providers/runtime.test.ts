import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  bundledRuntimeCandidates,
  discoverRuntime,
  runtimeCandidates,
  supportedVersion,
} from './runtime'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  // Canonical root: discovery returns realpaths (/var on macOS, 8.3 names on Windows).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'Runtime discovery with spaces ')))
  roots.push(root)
  return root
}
async function executable(path: string, version: string) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
  await chmod(path, 0o755)
}
it.skipIf(process.platform === 'win32')(
  'production discovery skips old external versions and reports all incompatible paths',
  async () => {
    const home = await fixture()
    const old = join(home, '.local/bin/claude')
    const current = join(home, 'current/claude')
    await executable(old, '2.1.1')
    await executable(current, '2.1.299 (Claude Code)')
    const options = { home, development: false }
    expect(await discoverRuntime('claude', { PATH: join(home, 'current') }, options)).toBe(current)
    await executable(current, '2.1.300')
    await expect(
      discoverRuntime('claude', { PATH: join(home, 'current') }, options),
    ).rejects.toThrow(old + ': 2.1.1')
    await expect(
      discoverRuntime('claude', { PATH: join(home, 'current') }, options),
    ).rejects.toThrow(current + ': 2.1.300')
  },
)
it.skipIf(process.platform === 'win32')(
  'production discovery probes one executable reached through several paths once',
  async () => {
    const home = await fixture()
    const real = join(home, 'real/claude')
    await executable(real, '2.1.1')
    await mkdir(join(home, 'linked'))
    await symlink(real, join(home, 'linked/claude'))
    const PATH = [join(home, 'real'), join(home, 'linked')].join(delimiter)
    const error = await discoverRuntime('claude', { PATH }, { home, development: false }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message.split(real).length - 1).toBe(1)
  },
)
it.skipIf(process.platform === 'win32')(
  'production discovery prefers the packaged absolute path over external executables',
  async () => {
    const home = await fixture()
    const resourcesPath = join(home, 'resources')
    const bundled = bundledRuntimeCandidates(
      'claude',
      resourcesPath,
      process.platform,
      process.arch,
    )[0]
    if (!bundled) throw new Error('Unsupported test platform')
    await executable(bundled, '2.1.299')
    await executable(join(home, '.local/bin/claude'), '2.1.1')
    expect(await discoverRuntime('claude', { PATH: '' }, { home, resourcesPath })).toBe(bundled)
  },
)
it('matches architecture explicitly and includes nested npm optional dependencies', async () => {
  expect(bundledRuntimeCandidates('codex', '/resources', 'win32', 'arm64')).toEqual([])
  expect(bundledRuntimeCandidates('claude', '/resources', 'win32', 'ia32')).toEqual([])
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
