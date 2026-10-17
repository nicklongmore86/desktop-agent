import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConnectionService } from './service'
import { connectCodex, createCodexRunner, codexLogin } from './codex'
import { createClaudeSubscriptionRunner } from './claude'
import { capture } from './runtime'
import { CLAUDE_FAILURES, mapFailure } from './errors'
import { RpcPeer } from './rpc'
import { openSettingsStore } from '../storage/settings-store'

vi.mock('./codex', async (original) => ({
  ...(await original<typeof import('./codex')>()),
  connectCodex: vi.fn(),
  codexLogin: vi.fn(),
  createCodexRunner: vi.fn(),
}))
vi.mock('./claude', async (original) => ({
  ...(await original<typeof import('./claude')>()),
  createClaudeSubscriptionRunner: vi.fn(),
}))
vi.mock('./runtime', async (original) => ({
  ...(await original<typeof import('./runtime')>()),
  capture: vi.fn(),
  killRuntime: vi.fn(),
}))
let dir: string
let service: ConnectionService
let settings: Awaited<ReturnType<typeof openSettingsStore>>
let request: ReturnType<typeof vi.fn<(method: string, ...args: unknown[]) => Promise<unknown>>>
let close: ReturnType<typeof vi.fn>
let used: number
beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-01-15T00:00:00Z'))
  vi.mocked(capture).mockResolvedValue(
    JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'Max' }),
  )
  vi.mocked(createClaudeSubscriptionRunner).mockReturnValue({ run: vi.fn() })
  dir = await mkdtemp(join(tmpdir(), 'catalog-service-'))
  settings = await openSettingsStore(join(dir, 'settings.json'))
  service = new ConnectionService(dir, vi.fn(), { settings })
  vi.spyOn(service, 'context').mockResolvedValue({ file: '/fake', cwd: dir, env: {} })
  used = 10
  close = vi.fn()
  request = vi.fn<(method: string, ...args: unknown[]) => Promise<unknown>>((method) => {
    if (method === 'account/read') return Promise.resolve({ account: { type: 'chatgpt' } })
    if (method === 'model/list')
      return Promise.resolve({
        data: [
          {
            model: 'gpt-5.6-terra',
            displayName: 'Terra',
            isDefault: true,
            defaultReasoningEffort: 'medium',
          },
          { model: 'gpt-5.6-sol', displayName: 'Sol', defaultReasoningEffort: 'high' },
        ],
        nextCursor: null,
      })
    if (method === 'account/rateLimits/read')
      return Promise.resolve({
        ordinaryUsageAllowed: used < 100,
        rateLimits: { planType: 'free', primary: { usedPercent: used, resetsAt: 1800000000 } },
        rateLimitsByLimitId: null,
      })
    throw new Error('Unexpected request')
  })
  vi.mocked(connectCodex).mockResolvedValue({ request, close } as unknown as RpcPeer)
  vi.mocked(createCodexRunner).mockReturnValue({ run: vi.fn() })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})
it('persists validated model choice, exposes selection and records resolved model separately', async () => {
  expect(await service.models('codex-subscription')).toMatchObject({
    selectedModel: 'gpt-5.6-terra',
    savedModel: null,
  })
  await expect(service.setModel('codex-subscription', 'nonexistent')).rejects.toMatchObject({
    code: 'model_unavailable',
  })
  expect(settings.selection('codex-subscription')).toBeNull()
  expect(await service.setModel('codex-subscription', 'gpt-5.6-sol')).toMatchObject({
    selectedModel: 'gpt-5.6-sol',
    savedModel: 'gpt-5.6-sol',
  })
  await service.runner('codex-subscription', [])
  const preferences = vi.mocked(createCodexRunner).mock.calls[0]?.[2]
  expect(preferences?.model).toBe('gpt-5.6-sol')
  preferences?.onResolvedModel?.('gpt-5.6-terra')
  expect(await service.models('codex-subscription')).toMatchObject({
    selectedModel: 'gpt-5.6-sol',
    resolvedModel: 'gpt-5.6-terra',
  })
  expect(await service.setModel('codex-subscription', null)).toMatchObject({
    selectedModel: 'gpt-5.6-terra',
    savedModel: null,
    resolvedModel: null,
  })
  expect(close).toHaveBeenCalledTimes(5)
})
it('reports backend denial but allows an explicit Send to reach the authoritative runtime', async () => {
  used = 100
  expect(await service.status('codex-subscription')).toMatchObject({
    signedIn: true,
    availability: 'blocked',
    state: 'limited',
    failure: { code: 'usage_limit', resetsAt: '2027-01-15T08:00:00.000Z' },
  })
  await service.runner('codex-subscription', [])
  expect(createCodexRunner).toHaveBeenCalledOnce()
  expect(await service.allowance('codex-subscription')).toMatchObject({
    plan: 'free',
    state: 'limited',
    windows: [{ remainingPercent: 0 }],
  })
})
it('distinguishes unknown allowance from sign-in and supports non-Codex capability discovery', async () => {
  expect(await service.models('claude-subscription')).toMatchObject({
    options: [],
    selectedModel: null,
  })
  expect(await service.allowance('claude-subscription')).toMatchObject({
    state: 'unknown',
    windows: [],
    plan: null,
  })
  await expect(service.setModel('claude-subscription', 'sonnet')).rejects.toMatchObject({
    code: 'model_unavailable',
  })
})
it('keeps remembered Codex model denials display-only', async () => {
  await service.runner('codex-subscription', [])
  const preferences = vi.mocked(createCodexRunner).mock.calls[0]?.[2]
  preferences?.onFailure?.({ code: 'plan_not_entitled', message: 'Choose an available model.' })
  expect(await service.status('codex-subscription')).toMatchObject({
    signedIn: true,
    state: 'ready',
  })
  await service.setModel('codex-subscription', 'gpt-5.6-terra')
  expect(await service.status('codex-subscription')).toMatchObject({
    state: 'ready',
    availability: 'available',
  })
})
it('sanitizes metadata setup errors before rejecting an IPC call', async () => {
  vi.spyOn(service, 'context').mockRejectedValue(new Error('Missing runtime: C:/private/secret'))
  await expect(service.models('codex-subscription')).rejects.toMatchObject({
    code: 'runtime_unavailable',
  })
  await expect(service.allowance('codex-subscription')).rejects.not.toThrow('private')
})

it('reuses catalogs for 60 seconds and invalidates on explicit metadata invalidation and model change', async () => {
  const peer = { request, close } as unknown as RpcPeer
  await service.models('codex-subscription')
  await service.runner('codex-subscription', [])
  await vi.mocked(createCodexRunner).mock.calls.at(-1)?.[2]?.catalog?.(peer)
  expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(1)
  expect(connectCodex).toHaveBeenCalledOnce() // creating a runner does not spawn a preflight process
  vi.mocked(Date.now).mockReturnValue(Date.parse('2027-01-15T00:01:01Z'))
  await service.models('codex-subscription')
  expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(2)
  service.invalidateMetadata()
  await service.models('codex-subscription')
  expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(3)
  await service.setModel('codex-subscription', 'gpt-5.6-sol')
  await service.models('codex-subscription')
  expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(5)
})
it.each(['reject', 'timeout'] as const)(
  'keeps signed-in status ready and Send usable after allowance %s',
  async (mode) => {
    const original = request.getMockImplementation()
    request.mockImplementation((method: string, ...args: unknown[]) => {
      if (method !== 'account/rateLimits/read') {
        if (!original) throw new Error('Missing request fixture')
        return original(method, ...args)
      }
      return Promise.reject(
        new Error(mode === 'timeout' ? 'Runtime request timed out.' : 'Usage endpoint unavailable'),
      )
    })
    expect(await service.status('codex-subscription')).toMatchObject({
      signedIn: true,
      state: 'ready',
      availability: 'unknown',
    })
    await service.runner('codex-subscription', [])
    expect(createCodexRunner).toHaveBeenCalledOnce()
  },
)
it.each(['plan', 'quota-json'] as const)(
  'does not lock a Max user after a free-text %s guess',
  async (kind) => {
    await service.runner('claude-subscription', [])
    const observe = vi.mocked(createClaudeSubscriptionRunner).mock.calls.at(-1)?.[2]
    observe?.onAccount?.('Max')
    const failure = mapFailure(
      {
        result:
          kind === 'plan'
            ? 'A subscription is required for this free Claude code sample'
            : JSON.stringify({ code: 'usage_limit', resetsAt: 1800000000 }),
      },
      CLAUDE_FAILURES,
    )
    observe?.onFailure?.(failure)
    expect(failure.code).toBe(kind === 'plan' ? 'plan_not_entitled' : 'usage_limit')
    await service.runner('claude-subscription', [])
    expect(createClaudeSubscriptionRunner).toHaveBeenCalledTimes(2)
  },
)
it('gates Claude only for a rejected structured limit with a plausible future reset, then recovers', async () => {
  await service.runner('claude-subscription', [])
  const observe = vi.mocked(createClaudeSubscriptionRunner).mock.calls.at(-1)?.[2]
  observe?.onLimit?.('2027-01-15T08:00:00.000Z')
  observe?.onFailure?.(mapFailure({ code: 'usage_limit', resetsAt: 1800000000 }, CLAUDE_FAILURES))
  await expect(service.runner('claude-subscription', [])).rejects.toMatchObject({
    code: 'usage_limit',
  })
  vi.mocked(Date.now).mockReturnValue(Date.parse('2027-01-15T09:00:00Z'))
  await service.runner('claude-subscription', [])
  expect(createClaudeSubscriptionRunner).toHaveBeenCalledTimes(2)
})
it.each([undefined, '2099-01-01T00:00:00Z', '2026-01-01T00:00:00Z'])(
  'does not gate an unbounded or invalid structured reset %s',
  async (reset) => {
    await service.runner('claude-subscription', [])
    const observe = vi.mocked(createClaudeSubscriptionRunner).mock.calls.at(-1)?.[2]
    observe?.onLimit?.(reset)
    observe?.onFailure?.({ code: 'usage_limit', message: 'Limit reached.' })
    await service.runner('claude-subscription', [])
    expect(createClaudeSubscriptionRunner).toHaveBeenCalledTimes(2)
  },
)

it('bounds a genuinely stalled allowance read and keeps Send usable', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  })
  child.stdin.on('data', (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as { method: string; id: number }
    if (message.method === 'account/read')
      queueMicrotask(() =>
        child.stdout.write(
          JSON.stringify({ id: message.id, result: { account: { type: 'chatgpt' } } }) + '\n',
        ),
      )
  })
  const peer = new RpcPeer(child as unknown as ChildProcessWithoutNullStreams)
  vi.mocked(connectCodex).mockResolvedValue(peer)
  expect(await service.status('codex-subscription')).toMatchObject({
    state: 'ready',
    signedIn: true,
    availability: 'unknown',
  })
  await service.runner('codex-subscription', [])
  expect(createCodexRunner).toHaveBeenCalledOnce()
})
it('does not repopulate invalidated catalogs from an in-flight read', async () => {
  const original = request.getMockImplementation()
  let release: (value: unknown) => void = () => {}
  request.mockImplementation((method: string, ...args: unknown[]) => {
    if (method === 'model/list')
      return new Promise((resolve) => {
        release = resolve
      })
    if (!original) throw new Error('Missing fixture')
    return original(method, ...args)
  })
  const reading = service.models('codex-subscription')
  await vi.waitFor(() => {
    expect(request.mock.calls.some(([method]) => method === 'model/list')).toBe(true)
  })
  service.invalidateMetadata()
  release({ data: [{ model: 'gpt-5.6-terra', isDefault: true }], nextCursor: null })
  await reading
  if (!original) throw new Error('Missing fixture')
  request.mockImplementation(original)
  await service.models('codex-subscription')
  expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(2)
})

it('invalidates a previously cached catalog when subscription sign-in runs', async () => {
  await service.models('codex-subscription')
  vi.mocked(codexLogin).mockResolvedValue(undefined)
  expect(await service.login('codex-subscription')).toMatchObject({ state: 'ready' })
  await service.models('codex-subscription')
  expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(2)
})
