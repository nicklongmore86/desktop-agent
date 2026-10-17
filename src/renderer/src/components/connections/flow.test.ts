import { describe, expect, it } from 'vitest'
import type { ProviderStatus } from '../../../../shared/ipc'
import { BUILTIN_CONNECTION_INFO } from '../../../../shared/connections-fixture'
import {
  canGoBack,
  flowReducer,
  initialFlow,
  isConnected,
  isReady,
  stepNumber,
  type FlowEvent,
  type FlowState,
} from './flow'

const run = (events: FlowEvent[], from: FlowState = initialFlow): FlowState =>
  events.reduce(flowReducer, from)

describe('add connection flow', () => {
  it('walks provider, access, connect, model, folder, done', () => {
    let state = initialFlow
    const seen = [state.step]
    for (const event of [
      { type: 'provider', provider: 'claude' },
      { type: 'access', access: 'api-key', connection: 'anthropic-api' },
      { type: 'connected' },
      { type: 'model-done' },
      { type: 'folder-done' },
    ] as const) {
      state = flowReducer(state, event)
      seen.push(state.step)
    }
    expect(seen).toEqual(['provider', 'access', 'connect', 'model', 'folder', 'done'])
    expect(state).toMatchObject({
      provider: 'claude',
      access: 'api-key',
      connection: 'anthropic-api',
    })
  })

  it('leaves the connection open on the connect step when there is a choice to make', () => {
    const chosen = run([
      { type: 'provider', provider: 'local' },
      { type: 'access', access: 'free', connection: null },
    ])
    expect(chosen).toMatchObject({ step: 'connect', connection: null })
    // Connected needs a connection: nothing happens until one is picked.
    expect(flowReducer(chosen, { type: 'connected' })).toBe(chosen)
    expect(flowReducer(chosen, { type: 'connection', connection: 'ollama' })).toMatchObject({
      step: 'connect',
      connection: 'ollama',
    })
  })

  it('goes back one step at a time, forgetting what came after', () => {
    const atConnect = run([
      { type: 'provider', provider: 'gemini' },
      { type: 'access', access: 'api-key', connection: 'gemini-api' },
    ])
    const atAccess = flowReducer(atConnect, { type: 'back' })
    expect(atAccess).toMatchObject({
      step: 'access',
      provider: 'gemini',
      access: null,
      connection: null,
    })
    expect(flowReducer(atAccess, { type: 'back' })).toEqual(initialFlow)
    expect(flowReducer(initialFlow, { type: 'back' })).toBe(initialFlow)
  })

  it('lets Back revisit model and folder, but not leave the finished screen', () => {
    const atFolder = run([
      {
        type: 'start-at',
        provider: 'chatgpt',
        access: 'subscription',
        connection: 'codex-subscription',
      },
      { type: 'connected' },
      { type: 'model-done' },
    ])
    expect(atFolder.step).toBe('folder')
    expect(flowReducer(atFolder, { type: 'back' }).step).toBe('model')
    const done = flowReducer(atFolder, { type: 'folder-done' })
    expect(canGoBack(done)).toBe(false)
    expect(flowReducer(done, { type: 'back' })).toBe(done)
  })

  it('ignores events that do not belong to the current step', () => {
    expect(flowReducer(initialFlow, { type: 'model-done' })).toBe(initialFlow)
    expect(flowReducer(initialFlow, { type: 'folder-done' })).toBe(initialFlow)
    expect(flowReducer(initialFlow, { type: 'connected' })).toBe(initialFlow)
    expect(flowReducer(initialFlow, { type: 'access', access: 'free', connection: 'ollama' })).toBe(
      initialFlow,
    )
  })

  it('starts at the connect step for a connection that already exists', () => {
    expect(
      flowReducer(initialFlow, {
        type: 'start-at',
        provider: 'claude',
        access: 'subscription',
        connection: 'claude-subscription',
      }),
    ).toEqual({
      step: 'connect',
      provider: 'claude',
      access: 'subscription',
      connection: 'claude-subscription',
    })
  })

  it('counts five steps, and the finished screen is not one of them', () => {
    expect(stepNumber('provider')).toEqual({ current: 1, total: 5 })
    expect(stepNumber('folder')).toEqual({ current: 5, total: 5 })
    expect(stepNumber('done').current).toBe(5)
    expect(canGoBack(initialFlow)).toBe(false)
  })
})

describe('readiness', () => {
  const status = (state: ProviderStatus['state'], extra: Partial<ProviderStatus> = {}) => ({
    provider: 'x',
    state,
    message: 'm',
    ...extra,
  })
  const builtin = (id: string) => {
    const found = BUILTIN_CONNECTION_INFO.find((info) => info.id === id)
    if (!found) throw new Error(`No fixture for ${id}`)
    return found
  }
  const claude = builtin('claude-subscription')
  const api = builtin('anthropic-api')

  it('counts ready, limited and signed-in as connected, and nothing else', () => {
    expect(isConnected(status('ready'))).toBe(true)
    expect(isConnected(status('limited'))).toBe(true)
    expect(isConnected(status('not-entitled', { signedIn: true }))).toBe(true)
    for (const state of ['signed-out', 'missing-runtime', 'error', 'unsupported'] as const)
      expect(isConnected(status(state))).toBe(false)
    expect(isConnected(null)).toBe(false)
  })

  it('decides an API-key connection by its saved key, not its status', () => {
    expect(isReady(api, status('ready'), false)).toBe(false)
    expect(isReady(api, status('ready'), undefined)).toBe(false)
    expect(isReady(api, null, true)).toBe(true)
    expect(isReady(claude, status('signed-out'), undefined)).toBe(false)
    expect(isReady(claude, status('ready'), undefined)).toBe(true)
  })
})
