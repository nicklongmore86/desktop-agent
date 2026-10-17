import type { Message } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_CONNECTION_INFO } from '../../shared/connections-fixture'
import type { AgentClient, AgentStream } from '../agent'
import type { ApiKeyStore } from '../secrets'
import { agentClientAdapter, type AgentClientSpec } from './adapters/agent-client'
import type { AdapterFactory, ConnectionAdapter } from './connection'
import { CLAUDE_FAILURES } from './errors'
import { ConnectionRegistry } from './registry'
import { ConnectionService } from './service'

const spec = (overrides: Partial<AgentClientSpec> = {}): AgentClientSpec => ({
  id: 'openai-api',
  vendor: 'openai',
  access: 'api-key',
  label: 'GPT · API',
  shortLabel: 'GPT API',
  title: 'OpenAI API',
  description: 'Use your own API key.',
  capabilities: {
    authKind: 'api-key',
    listsModels: false,
    reportsUsage: false,
    needsRuntime: false,
  },
  personalUseOnly: false,
  pickerOrder: 3,
  client: () => fakeClient('hello from the new connection').client,
  model: () => 'gpt-test',
  readyMessage: 'Ready.',
  missingKeyMessage: 'Add your OpenAI API key in Settings.',
  wording: CLAUDE_FAILURES,
  ...overrides,
})

/** One streamed reply with no tool calls. */
function fakeClient(text: string) {
  const stream = vi.fn<AgentClient['messages']['stream']>((): AgentStream => {
    const listeners: ((delta: string) => void)[] = []
    return {
      on: (_event, listener) => listeners.push(listener),
      finalMessage: () => {
        for (const listener of listeners) listener(text)
        return Promise.resolve({
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'gpt-test',
          content: [{ type: 'text', text, citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Message)
      },
      abort: vi.fn(),
    }
  })
  const client: AgentClient = { messages: { stream } }
  return { client, stream }
}

function keysWith(key: string | null | Error) {
  const store: ApiKeyStore = {
    get: () => (key instanceof Error ? Promise.reject(key) : Promise.resolve(key)),
    hasKey: () => Promise.resolve(typeof key === 'string'),
    set: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  }
  return { forConnection: vi.fn(() => store) }
}

describe('built-in connections', () => {
  const service = new ConnectionService('/unused', vi.fn())

  it('describes each old provider as a vendor plus an access type, with the same ids', () => {
    expect(
      service.registry
        .list({ personalUse: true })
        .map(({ id, vendor, access, capabilities, personalUseOnly }) => ({
          id,
          vendor,
          access,
          authKind: capabilities.authKind,
          personalUseOnly,
        })),
    ).toEqual([
      {
        id: 'claude-subscription',
        vendor: 'anthropic',
        access: 'subscription',
        authKind: 'runtime-login',
        personalUseOnly: true,
      },
      {
        id: 'codex-subscription',
        vendor: 'openai',
        access: 'subscription',
        authKind: 'runtime-login',
        personalUseOnly: false,
      },
      {
        id: 'anthropic-api',
        vendor: 'anthropic',
        access: 'api-key',
        authKind: 'api-key',
        personalUseOnly: false,
      },
    ])
  })

  it('lists exactly what the renderer fakes answer with', () => {
    expect(service.registry.list({ personalUse: true })).toEqual(BUILTIN_CONNECTION_INFO)
  })

  it('hides personal-use connections when they are not shown', () => {
    expect(service.registry.list({ personalUse: false }).map(({ id }) => id)).toEqual([
      'codex-subscription',
      'anthropic-api',
    ])
  })

  it('refuses an id it does not know, before any adapter runs', async () => {
    await expect(service.status('openai-api')).rejects.toThrow('Unknown provider.')
    await expect(service.login('../claude')).rejects.toThrow('Unknown provider.')
    await expect(service.runner('evil', [])).rejects.toThrow('Unknown provider.')
  })

  it('offers no model list where the connection has none, and refuses to save one', async () => {
    expect(await service.models('anthropic-api')).toMatchObject({ options: [], savedModel: null })
    await expect(service.setModel('anthropic-api', 'x')).rejects.toMatchObject({
      code: 'model_unavailable',
    })
    expect(await service.allowance('anthropic-api')).toMatchObject({
      state: 'unknown',
      lastError: null,
    })
  })
})

describe('registry', () => {
  const adapter = (id: string, extra: Partial<ConnectionAdapter> = {}): ConnectionAdapter => ({
    ...agentClientAdapter(spec({ id }))({} as never),
    ...extra,
  })

  it('refuses malformed and duplicate ids, unknown vendors and access types', () => {
    const registry = new ConnectionRegistry()
    registry.register(adapter('openai-api'))
    expect(() => {
      registry.register(adapter('openai-api'))
    }).toThrow('already registered')
    for (const id of ['../x', 'A', '', 'a/b', 'x'.repeat(65)])
      expect(() => {
        registry.register(adapter(id))
      }).toThrow('Invalid connection id')
    expect(() => {
      registry.register(adapter('x', { vendor: 'acme' as never }))
    }).toThrow('Unknown vendor')
    expect(() => {
      registry.register(adapter('y', { access: 'trial' as never }))
    }).toThrow('Unknown access type')
    expect(registry.ids()).toEqual(['openai-api'])
    expect(registry.has('__proto__')).toBe(false)
    expect(registry.has(7)).toBe(false)
  })
})

describe('an API connection registered through the AgentClient slot', () => {
  const setup = (key: string | null | Error, overrides: Partial<AgentClientSpec> = {}) => {
    const keys = keysWith(key)
    const service = new ConnectionService('/unused', vi.fn(), { keys })
    const client = vi.fn(spec(overrides).client)
    service.registerAdapter(agentClientAdapter(spec({ ...overrides, client })))
    return { service, keys, client }
  }

  it('runs the shared agent loop with the connection’s own key and model', async () => {
    const fake = fakeClient('hello from the new connection')
    const { service, keys, client } = setup('sk-openai', { client: () => fake.client })
    expect(await service.status('openai-api')).toEqual({
      provider: 'openai-api',
      state: 'ready',
      message: 'Ready.',
    })
    const runner = await service.runner('openai-api', [])
    expect(keys.forConnection).toHaveBeenCalledWith('openai-api')
    expect(client).toHaveBeenCalledWith({ key: 'sk-openai' })
    const onEvent = vi.fn()
    const result = await runner.run([{ role: 'user', content: 'hi' }], {
      signal: new AbortController().signal,
      onEvent,
      requestApproval: () => Promise.resolve(false),
    })
    expect(result.stopReason).toBe('end_turn')
    expect(onEvent).toHaveBeenCalledWith({
      type: 'text_delta',
      turn: 1,
      text: 'hello from the new connection',
    })
    const [params] = fake.stream.mock.calls[0] ?? []
    expect(params).toMatchObject({ model: 'gpt-test' })
  })

  it('refuses to start without a key, and maps key failures without the store’s internals', async () => {
    const missing = setup(null)
    const error = await missing.service.runner('openai-api', []).catch((e: unknown) => e)
    expect(missing.service.failure('openai-api', error)).toEqual({
      code: 'no_api_key',
      message: 'Add your OpenAI API key in Settings.',
    })
    expect(missing.client).not.toHaveBeenCalled()
    const unreadable = setup(new Error('Stored API key is corrupt.'))
    const failure = await unreadable.service.runner('openai-api', []).catch((e: unknown) => e)
    expect(unreadable.service.failure('openai-api', failure)).toEqual({
      code: 'key_unreadable',
      message: 'Stored API key is corrupt.',
    })
  })

  it('never forwards a provider’s own error text', () => {
    const { service } = setup('sk')
    const failure = service.failure(
      'openai-api',
      new Error('429 rate_limit for sk-secret at C:\\Users\\me'),
    )
    expect(failure.code).toBe('usage_limit')
    expect(JSON.stringify(failure)).not.toMatch(/sk-secret|Users/)
  })

  it('needs no key for a local connection', async () => {
    const { service, keys, client } = setup(null, {
      id: 'local-llm',
      vendor: 'local',
      access: 'free',
      capabilities: {
        authKind: 'local',
        listsModels: false,
        reportsUsage: false,
        needsRuntime: false,
      },
    })
    await service.runner('local-llm', [])
    expect(keys.forConnection).not.toHaveBeenCalled()
    expect(client).toHaveBeenCalledWith({ key: null })
  })
})

describe('sign-in', () => {
  it('allows one sign-in at a time across every connection, and Cancel ends it', async () => {
    const started: string[] = []
    const login =
      (id: string): AdapterFactory =>
      (host) => ({
        ...agentClientAdapter(spec({ id }))(host),
        capabilities: {
          authKind: 'runtime-login',
          listsModels: false,
          reportsUsage: false,
          needsRuntime: true,
        },
        login: (session) => {
          started.push(id)
          return new Promise((_resolve, reject) => {
            session.signal.addEventListener('abort', () => {
              reject(new Error('aborted'))
            })
          })
        },
      })
    const states = vi.fn()
    const service = new ConnectionService('/unused', vi.fn(), {
      adapters: [login('first'), login('second')],
      onLoginState: states,
    })
    const first = service.login('first')
    expect(await service.login('second')).toEqual({
      provider: 'second',
      state: 'error',
      message: 'A sign-in is already in progress.',
    })
    expect(service.loginState()).toMatchObject({ provider: 'first', active: true })
    service.cancelLogin()
    expect(await first).toEqual({
      provider: 'first',
      state: 'error',
      message: 'Sign-in cancelled.',
    })
    expect(started).toEqual(['first'])
    expect(service.loginState()).toEqual({
      provider: null,
      active: false,
      url: null,
      result: null,
    })
    expect(states).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'first', active: false }),
    )
  })

  it('reports status for a connection with nothing to sign in to', async () => {
    const service = new ConnectionService('/unused', vi.fn())
    expect(await service.login('anthropic-api')).toMatchObject({ state: 'ready' })
    expect(service.loginState().active).toBe(false)
  })
})
