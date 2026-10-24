import { expect, it, vi, beforeEach, afterEach } from 'vitest'
import { codexAllowance, codexModels } from './catalog'
import type { RpcPeer } from './rpc'

const terra = {
  id: 'terra',
  model: 'gpt-5.6-terra',
  displayName: 'Terra',
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
}
const sol = { ...terra, id: 'sol', model: 'gpt-5.6-sol', displayName: 'Sol', isDefault: true }
function peerWith(...responses: unknown[]) {
  const request = vi.fn()
  responses.forEach((response) => request.mockResolvedValueOnce(response))
  return { peer: { request } as unknown as RpcPeer, request }
}
it('uses the Free account catalog, validates saved choice and preserves default effort', async () => {
  const { peer } = peerWith({ data: [terra], nextCursor: null })
  expect(await codexModels(peer, sol.model)).toMatchObject({
    selectedModel: terra.model,
    defaultModel: terra.model,
    savedModel: sol.model,
    options: [{ defaultReasoningEffort: 'medium' }],
  })
})
it('paginates and prefers the account server default over the Free fallback', async () => {
  const { peer, request } = peerWith(
    { data: [terra], nextCursor: 'page2' },
    { data: [sol], nextCursor: null },
  )
  expect(await codexModels(peer, null)).toMatchObject({ selectedModel: sol.model })
  expect(request).toHaveBeenNthCalledWith(
    2,
    'model/list',
    {
      cursor: 'page2',
      includeHidden: false,
      limit: 100,
    },
    { timeoutMs: expect.any(Number) as unknown, closeOnTimeout: false },
  )
})
it('uses a valid saved model over the account default', async () => {
  const { peer } = peerWith({ data: [terra, sol], nextCursor: null })
  expect(await codexModels(peer, terra.model)).toMatchObject({
    selectedModel: terra.model,
    defaultModel: sol.model,
  })
})
it('does not invent a Free model absent from the catalog and excludes hidden models', async () => {
  const { peer } = peerWith({
    data: [
      { ...sol, isDefault: false },
      { ...terra, hidden: true },
    ],
    nextCursor: null,
  })
  expect(await codexModels(peer, null)).toMatchObject({
    selectedModel: sol.model,
    options: [{ id: sol.model }],
  })
})
it('fails closed on an empty catalog and cyclic pagination', async () => {
  await expect(
    codexModels(peerWith({ data: [], nextCursor: null }).peer, null),
  ).rejects.toMatchObject({ code: 'model_unavailable' })
  await expect(
    codexModels(peerWith({ data: [], nextCursor: 'x' }, { data: [], nextCursor: 'x' }).peer, null),
  ).rejects.toThrow('pagination')
})
it('normalizes remaining quota and Unix second reset timestamps without forwarding account details', async () => {
  const { peer, request } = peerWith({
    ordinaryUsageAllowed: false,
    rateLimits: {
      planType: 'free',
      primary: { usedPercent: 100, resetsAt: 1800000000 },
      secondary: { usedPercent: 25, resetsAt: null },
      token: 'secret',
    },
    rateLimitsByLimitId: null,
  })
  const allowance = await codexAllowance(peer)
  expect(allowance).toEqual({
    provider: 'codex-subscription',
    state: 'limited',
    plan: 'free',
    lastError: null,
    resetsAt: '2027-01-15T08:00:00.000Z',
    windows: [
      { limitId: 'codex:primary', remainingPercent: 0, resetsAt: '2027-01-15T08:00:00.000Z' },
      { limitId: 'codex:secondary', remainingPercent: 75, resetsAt: null },
    ],
  })
  expect(request).toHaveBeenCalledWith(
    'account/rateLimits/read',
    {
      excludeResetCreditDetails: true,
    },
    { timeoutMs: 1500, closeOnTimeout: false },
  )
})
it('labels windows from their length, and omits the label when it is absent or odd', async () => {
  const { peer } = peerWith({
    ordinaryUsageAllowed: true,
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300 },
      secondary: { usedPercent: 20, windowDurationMins: 10080 },
    },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 10, windowDurationMins: 300 },
        secondary: { usedPercent: 20, windowDurationMins: 10080 },
      },
      other: {
        primary: { usedPercent: 1, windowDurationMins: 45 },
        secondary: { usedPercent: 2, windowDurationMins: 2880 },
      },
      bare: { primary: { usedPercent: 3 } },
    },
  })
  const { windows } = await codexAllowance(peer)
  const labels = Object.fromEntries(windows.map((window) => [window.limitId, window.label]))
  expect(labels['codex:primary']).toBe('5-hour limit')
  expect(labels['codex:secondary']).toBe('weekly limit')
  expect(windows.find((window) => window.limitId === 'other:primary')).not.toHaveProperty('label')
  expect(windows.find((window) => window.limitId === 'bare:primary')).not.toHaveProperty('label')
  expect(windows.find((window) => window.limitId === 'other:secondary')?.label).toBe('2-day limit')
})
it('shows credits reported only on a bucket', async () => {
  const { peer } = peerWith({
    ordinaryUsageAllowed: true,
    rateLimits: { primary: { usedPercent: 1 } },
    rateLimitsByLimitId: {
      codex: { credits: { hasCredits: true, unlimited: false, balance: '12' } },
    },
  })
  const allowance = await codexAllowance(peer)
  expect(allowance.credits).toEqual({ hasCredits: true, unlimited: false })
})
it('reports unavailable allowance as unknown rather than unlimited', async () => {
  const { peer } = peerWith({
    rateLimits: { primary: null, secondary: null },
    rateLimitsByLimitId: null,
  })
  expect(await codexAllowance(peer)).toMatchObject({ state: 'unknown', windows: [] })
})
it('does not block Terra when a separate Sol bucket is exhausted', async () => {
  const current = {
    normalModelSlug: sol.model,
    primary: { usedPercent: 100, resetsAt: 1800000000 },
  }
  const { peer } = peerWith({
    ordinaryUsageAllowed: true,
    rateLimits: current,
    rateLimitsByLimitId: {
      sol: current,
      terra: { normalModelSlug: terra.model, primary: { usedPercent: 20, resetsAt: 1800000000 } },
    },
  })
  expect(await codexAllowance(peer)).toMatchObject({
    state: 'available',
    windows: [{ remainingPercent: 0 }, { remainingPercent: 80 }],
  })
})
it('prefers listed Terra over catalog order when the server supplies no default', async () => {
  const { peer } = peerWith({ data: [{ ...sol, isDefault: false }, terra], nextCursor: null })
  expect(await codexModels(peer, null)).toMatchObject({ selectedModel: terra.model })
})

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-01-15T00:00:00Z'))
})
afterEach(() => {
  vi.restoreAllMocks()
})

it.each([
  [true, null, 'available'],
  [false, { hasCredits: true, unlimited: false }, 'available'],
  [false, { hasCredits: false, unlimited: true }, 'available'],
  [false, null, 'limited'],
  [null, null, 'unknown'],
] as const)(
  'uses ordinaryUsageAllowed=%s and credits=%j at 100 percent',
  async (ordinaryUsageAllowed, credits, state) => {
    const { peer } = peerWith({
      ordinaryUsageAllowed,
      rateLimits: {
        primary: { usedPercent: 100 },
        spendControlReached: true,
        rateLimitReachedType: 'rate_limit_reached',
        credits,
      },
    })
    const allowance = await codexAllowance(peer)
    expect(allowance).toMatchObject({ state, windows: [{ remainingPercent: 0 }] })
    if (credits)
      expect(allowance.credits).toEqual({
        hasCredits: credits.hasCredits,
        unlimited: credits.unlimited,
      })
    expect(JSON.stringify(allowance)).not.toContain('balance')
  },
)
it('reads image input from inputModalities only; a missing list means text only', async () => {
  const { peer } = peerWith({
    data: [
      { ...sol, inputModalities: ['text', 'image'] },
      { ...terra, inputModalities: ['text'] },
      { ...terra, id: 'luna', model: 'gpt-5.6-luna' },
    ],
    nextCursor: null,
  })
  expect((await codexModels(peer, null)).options.map((o) => [o.id, o.imageInput])).toEqual([
    [sol.model, true],
    [terra.model, false],
    ['gpt-5.6-luna', false],
  ])
})
