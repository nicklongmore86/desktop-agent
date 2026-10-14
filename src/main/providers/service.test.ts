import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SubscriptionProviders } from './service'
import { capture, discoverRuntime, runtimeCandidates } from './runtime'
vi.mock('./runtime', async (original) => ({
  ...(await original<typeof import('./runtime')>()),
  capture: vi.fn(),
  discoverRuntime: vi.fn(),
}))
let dir: string
let provider: SubscriptionProviders
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'provider-status-'))
  provider = new SubscriptionProviders(dir, vi.fn())
  vi.mocked(discoverRuntime).mockResolvedValue('/official/claude')
  vi.mocked(capture).mockImplementation((_file, args) =>
    Promise.resolve(
      args[0] === '--version'
        ? '2.1.299 (Claude Code)'
        : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
    ),
  )
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(dir, { recursive: true, force: true })
})
it('reports missing runtimes with pinned install guidance', async () => {
  vi.mocked(discoverRuntime).mockResolvedValue(null)
  expect(await provider.status('claude-subscription')).toMatchObject({
    state: 'missing-runtime',
    message: expect.stringContaining('2.1.299') as unknown,
  })
})
it.each(['api_key', 'oauth_token', 'third_party', 'none'])(
  'rejects %s authentication without token substitution',
  async (authMethod) => {
    vi.mocked(capture).mockImplementation((_file, args) =>
      Promise.resolve(
        args[0] === '--version' ? '2.1.299' : JSON.stringify({ loggedIn: true, authMethod }),
      ),
    )
    expect(await provider.status('claude-subscription')).toMatchObject({ state: 'signed-out' })
  },
)
it('reports official subscription authentication ready and rejects unsupported versions', async () => {
  expect(await provider.status('claude-subscription')).toMatchObject({ state: 'ready' })
  // Discovery owns the version and integrity checks; status reports its errors.
  vi.mocked(discoverRuntime).mockRejectedValue(
    new Error('Unsupported claude runtime. Expected 2.1.299. Detected /x/claude: 2.1.300.'),
  )
  expect(await provider.status('claude-subscription')).toMatchObject({ state: 'unsupported' })
  expect(capture).not.toHaveBeenCalledWith(
    expect.anything(),
    ['--version'],
    expect.anything(),
    expect.anything(),
    expect.anything(),
  )
})
it('refuses injected configuration before launching a runtime', async () => {
  const home = join(dir, 'providers', 'claude')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'settings.json'), '{"hooks":{}}')
  expect(await provider.status('claude-subscription')).toMatchObject({ state: 'unsupported' })
  expect(capture).not.toHaveBeenCalled()
})
it('discovers Windows native npm binaries without cmd shims', () => {
  const candidates = runtimeCandidates('codex', '/Program Files/npm', 'win32', 'x64')
  expect(
    candidates.some((path) => path.includes('codex-win32-x64') && path.endsWith('codex.exe')),
  ).toBe(true)
  expect(candidates.every((path) => !path.endsWith('.cmd'))).toBe(true)
})
