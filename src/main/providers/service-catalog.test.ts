import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SubscriptionProviders } from './service'
import { connectCodex, createCodexRunner } from './codex'
import type { RpcPeer } from './rpc'
import { openSettingsStore } from '../storage/settings-store'

vi.mock('./codex', async (original) => ({
  ...(await original<typeof import('./codex')>()),
  connectCodex: vi.fn(),
  createCodexRunner: vi.fn(),
}))
let dir: string
let service: SubscriptionProviders
let settings: Awaited<ReturnType<typeof openSettingsStore>>
let request: ReturnType<typeof vi.fn>
let close: ReturnType<typeof vi.fn>
let used: number
beforeEach(async () => {
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'catalog-service-'))
  settings = await openSettingsStore(join(dir, 'settings.json'))
  service = new SubscriptionProviders(dir, vi.fn(), { settings })
  vi.spyOn(service, 'context').mockResolvedValue({ file: '/fake', cwd: dir, env: {} })
  used = 10
  close = vi.fn()
  request = vi.fn((method: string) => {
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
  expect(close).toHaveBeenCalledTimes(6)
})
it('reports signed-in but limited and prevents a turn from starting', async () => {
  used = 100
  expect(await service.status('codex-subscription')).toMatchObject({
    signedIn: true,
    availability: 'blocked',
    state: 'limited',
    failure: { code: 'usage_limit', resetsAt: '2027-01-15T08:00:00.000Z' },
  })
  await expect(service.runner('codex-subscription', [])).rejects.toMatchObject({
    code: 'usage_limit',
  })
  expect(createCodexRunner).not.toHaveBeenCalled()
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
it('clears a model entitlement failure after selecting another available model', async () => {
  await service.runner('codex-subscription', [])
  const preferences = vi.mocked(createCodexRunner).mock.calls[0]?.[2]
  preferences?.onFailure?.({ code: 'plan_not_entitled', message: 'Choose an available model.' })
  expect(await service.status('codex-subscription')).toMatchObject({
    signedIn: true,
    state: 'not-entitled',
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
