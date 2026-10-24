import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionId } from '../../../shared/ipc-connections'
import type { AgentEvent, AgentTool } from '../../agent'
import { pngShell } from '../../documents/fixtures.test-util'
import { GEMINI_FREE_TIER_NOTICE, GEMINI_HOST } from '../../llm/gemini'
import { makeSandbox, put, type Sandbox } from '../../permissions/test-support'
import type { ApiKeyStore, KeyStore } from '../../secrets'
import { openSettingsStore, type SettingsStore } from '../../storage/settings-store'
import { toolHarness } from '../../tools/test-support'
import type { AdapterFactory } from '../connection'
import { createAnthropicApiAdapter } from './anthropic-api'
import { ConnectionService } from '../service'
import { geminiApiAdapter } from './gemini-api'
import { lmStudioAdapter, ollamaAdapter } from './local-servers'
import { openAIApiAdapter } from './openai-api'
import { openRouterApiAdapter } from './openrouter-api'

interface Seen {
  method: string
  /** Path and query, as the pinned host would have received them. */
  path: string
  host: string
  headers: IncomingMessage['headers']
  body: unknown
}
type Route = (req: Seen, res: ServerResponse) => void

/**
 * A local stand-in for each provider. Requests are routed by "METHOD /path"; a route's
 * handlers answer in order and the last one repeats. `fetchFor(origin)` serves one
 * pinned host from here and records the origin each request was meant for.
 */
let server: Server
let routes: Map<string, Route[]>
let seen: Seen[]
let origin: string
let pending: string | undefined

const route = (key: string, ...handlers: Route[]): void => {
  routes.set(key, handlers)
}
const json =
  (status: number, body: unknown): Route =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
const sse =
  (...events: unknown[]): Route =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end()
  }

beforeEach(async () => {
  routes = new Map()
  seen = []
  server = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://local')
      const request: Seen = {
        method: req.method ?? '',
        path: `${url.pathname}${url.search}`,
        host: pending ?? origin,
        headers: req.headers,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      }
      pending = undefined
      seen.push(request)
      const handlers = routes.get(`${request.method} ${url.pathname}`)
      const handler = handlers && (handlers.length > 1 ? handlers.shift() : handlers[0])
      if (handler) handler(request, res)
      else res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

/** Serves `pinned` (and only it) from the fake server. */
function fetchFor(pinned: string) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== pinned) throw new Error(`unexpected host ${url.origin}`)
    pending = url.origin
    return fetch(`${origin}${url.pathname}${url.search}`, init)
  }
}

function memoryKeys(): KeyStore & { saved: Map<ConnectionId, string> } {
  const saved = new Map<ConnectionId, string>()
  return {
    saved,
    forConnection: (id): ApiKeyStore => ({
      get: () => Promise.resolve(saved.get(id) ?? null),
      hasKey: () => Promise.resolve(saved.has(id)),
      set: (key) => {
        saved.set(id, key)
        return Promise.resolve()
      },
      clear: () => {
        saved.delete(id)
        return Promise.resolve()
      },
    }),
  }
}

let dir: string
let settings: SettingsStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'new-connections-'))
  settings = await openSettingsStore(path.join(dir, 'settings.json'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function serviceWith(...adapters: AdapterFactory[]) {
  const keys = memoryKeys()
  const service = new ConnectionService(dir, vi.fn(), { settings, keys, adapters })
  return { service, keys }
}

async function run(
  service: ConnectionService,
  id: ConnectionId,
  tools: AgentTool[] = [],
): Promise<{ stopReason: string; events: AgentEvent[] }> {
  const events: AgentEvent[] = []
  const runner = await service.runner(id, tools)
  const { stopReason } = await runner.run([{ role: 'user', content: 'What is in my folder?' }], {
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    requestApproval: () => Promise.resolve(false),
  })
  return { stopReason, events }
}

const errorOf = (events: AgentEvent[]) => events.find((event) => event.type === 'error')

// Chat Completions stream chunks.
const delta = (value: Record<string, unknown>, finish: string | null = null) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: value, finish_reason: finish }],
})
const callDelta = (id: string, name: string, args: unknown) =>
  delta({
    tool_calls: [
      { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  })

const OPENAI = 'https://api.openai.com'
const OPENROUTER = 'https://openrouter.ai'

describe('OpenAI API', () => {
  const setup = () => serviceWith(openAIApiAdapter({ fetch: fetchFor(OPENAI) }))
  const models = json(200, {
    data: [{ id: 'gpt-4o' }, { id: 'gpt-5.1' }, { id: 'text-embedding-3-small' }, { id: 'tts-1' }],
  })

  it('reports a missing key, then checks a key with GET /models only, never a completion', async () => {
    const { service, keys } = setup()
    expect(await service.status('openai-api')).toMatchObject({
      state: 'signed-out',
      signedIn: false,
      message: 'Add your OpenAI API key in Settings.',
    })
    expect(seen).toEqual([])

    route('GET /v1/models', json(401, { error: { message: 'Incorrect API key sk-bad provided' } }))
    const refused = await service.validateKey('openai-api', 'sk-bad')
    expect(refused).toEqual({
      code: 'authentication',
      message: 'OpenAI rejected the API key. Update it in settings.',
    })
    expect(JSON.stringify(refused)).not.toContain('sk-bad')

    route('GET /v1/models', models)
    expect(await service.validateKey('openai-api', 'sk-good')).toBeNull()
    keys.saved.set('openai-api', 'sk-good')
    expect(await service.status('openai-api')).toMatchObject({ state: 'ready', signedIn: true })

    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/models', 'GET /v1/models'])
    expect(seen.every((r) => r.host === OPENAI)).toBe(true)
    expect(seen[1]?.headers.authorization).toBe('Bearer sk-good')
  })

  it('reports a saved key the server rejects, with the client’s own message', async () => {
    const { service, keys } = setup()
    keys.saved.set('openai-api', 'sk-revoked')
    route('GET /v1/models', json(401, { error: { message: 'revoked' } }))
    expect(await service.status('openai-api')).toEqual({
      provider: 'openai-api',
      state: 'error',
      signedIn: false,
      message: 'OpenAI rejected the API key. Update it in settings.',
      failure: {
        code: 'authentication',
        message: 'OpenAI rejected the API key. Update it in settings.',
      },
    })
  })

  it('lists chat models with a recommended default, and saves the choice per connection', async () => {
    const { service, keys } = setup()
    keys.saved.set('openai-api', 'sk-good')
    route('GET /v1/models', models)
    const listed = await service.models('openai-api')
    expect(listed.options.map((option) => option.id)).toEqual(['gpt-4o', 'gpt-5.1'])
    expect(listed).toMatchObject({ defaultModel: 'gpt-5.1', selectedModel: 'gpt-5.1' })
    expect(listed.savedModel).toBeNull()

    expect(await service.setModel('openai-api', 'gpt-4o')).toMatchObject({
      savedModel: 'gpt-4o',
      selectedModel: 'gpt-4o',
    })
    await expect(service.setModel('openai-api', 'gpt-9')).rejects.toMatchObject({
      code: 'model_unavailable',
    })
    const reopened = await openSettingsStore(path.join(dir, 'settings.json'))
    expect(reopened.selection('openai-api')).toBe('gpt-4o')
    // Never a switch: chats still go to the connection they went to.
    expect(reopened.connection).toBe('anthropic-api')
  })

  it('runs a tool round trip through the real agent loop', async () => {
    const sb: Sandbox = await makeSandbox()
    try {
      await put(path.join(sb.root, 'notes.txt'), 'buy milk')
      const { service, keys } = setup()
      keys.saved.set('openai-api', 'sk-good')
      route('GET /v1/models', models)
      route(
        'POST /v1/chat/completions',
        sse(callDelta('call_1', 'list_dir', { path: sb.root }), delta({}, 'tool_calls')),
        sse(delta({ content: 'You have notes.txt.' }), delta({}, 'stop')),
      )
      const { stopReason, events } = await run(
        service,
        'openai-api',
        Object.values(toolHarness(sb).tools),
      )
      expect(stopReason).toBe('end_turn')
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_result',
          result: expect.objectContaining({
            content: expect.stringContaining('notes.txt') as unknown,
          }) as unknown,
        }),
      )
      const completions = seen.filter((r) => r.path === '/v1/chat/completions')
      expect(completions).toHaveLength(2)
      const second = completions[1]?.body as { model: string; messages: { role: string }[] }
      // The recommended model, since none was chosen.
      expect(second.model).toBe('gpt-5.1')
      expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
      expect(JSON.stringify(second.messages)).toContain('notes.txt')
      expect(seen.every((r) => r.host === OPENAI)).toBe(true)
    } finally {
      await sb.cleanup()
    }
  })

  it('refuses to start without a key', async () => {
    const { service } = setup()
    const error = await service.runner('openai-api', []).catch((e: unknown) => e)
    expect(service.failure('openai-api', error)).toEqual({
      code: 'no_api_key',
      message: 'Add your OpenAI API key in Settings.',
    })
  })
})

describe('Gemini API', () => {
  const setup = () => serviceWith(geminiApiAdapter({ fetch: fetchFor(GEMINI_HOST) }))
  const models = json(200, {
    models: [
      {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-2.5-flash-image',
        displayName: 'Image',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/text-embedding-004',
        displayName: 'Embedding',
        supportedGenerationMethods: ['embedContent'],
      },
    ],
  })
  const parts = (value: unknown[], finishReason = 'STOP') => ({
    candidates: [{ content: { role: 'model', parts: value }, finishReason }],
  })

  it('tells the renderer about free-tier data use', () => {
    const { service } = setup()
    const info = service.registry.list({ personalUse: true })[0]
    expect(info?.notice).toContain(GEMINI_FREE_TIER_NOTICE.text)
  })

  it('checks a key with models.list only, and refuses an invalid one', async () => {
    const { service, keys } = setup()
    expect(await service.status('gemini-api')).toMatchObject({ state: 'signed-out' })
    route(
      'GET /v1beta/models',
      json(400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'API key not valid. Please pass a valid API key.',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
          ],
        },
      }),
    )
    const refused = await service.validateKey('gemini-api', 'AIza-bad')
    expect(refused?.code).toBe('authentication')
    route('GET /v1beta/models', models)
    expect(await service.validateKey('gemini-api', 'AIza-good')).toBeNull()
    keys.saved.set('gemini-api', 'AIza-good')
    expect(await service.status('gemini-api')).toMatchObject({ state: 'ready' })
    expect(seen.every((r) => r.method === 'GET' && r.path.startsWith('/v1beta/models?'))).toBe(true)
    expect(seen.every((r) => r.host === GEMINI_HOST)).toBe(true)
    expect(seen.at(-1)?.headers['x-goog-api-key']).toBe('AIza-good')
  })

  it('lists chat models only, recommending Flash', async () => {
    const { service, keys } = setup()
    keys.saved.set('gemini-api', 'AIza-good')
    route('GET /v1beta/models', models)
    const listed = await service.models('gemini-api')
    expect(listed.options.map((option) => [option.id, option.label])).toEqual([
      ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
      ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ])
    expect(listed.defaultModel).toBe('gemini-2.5-flash')
  })

  it('runs a tool round trip through the real agent loop', async () => {
    const sb = await makeSandbox()
    try {
      await put(path.join(sb.root, 'notes.txt'), 'buy milk')
      const { service, keys } = setup()
      keys.saved.set('gemini-api', 'AIza-good')
      await settings.setSelection('gemini-api', 'gemini-2.5-pro')
      route(
        'POST /v1beta/models/gemini-2.5-pro:streamGenerateContent',
        sse(parts([{ functionCall: { id: 'g1', name: 'list_dir', args: { path: sb.root } } }])),
        sse(parts([{ text: 'You have notes.txt.' }])),
      )
      const { stopReason, events } = await run(
        service,
        'gemini-api',
        Object.values(toolHarness(sb).tools),
      )
      expect(stopReason).toBe('end_turn')
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'text_delta', text: 'You have notes.txt.' }),
      )
      const calls = seen.filter((r) => r.method === 'POST')
      expect(calls).toHaveLength(2)
      expect(JSON.stringify(calls[1]?.body)).toContain('notes.txt')
      // A saved model is used as is: no list request before the Send.
      expect(seen.some((r) => r.method === 'GET')).toBe(false)
      expect(seen.every((r) => r.host === GEMINI_HOST)).toBe(true)
    } finally {
      await sb.cleanup()
    }
  })

  it('names Gemini, never Claude, when the output token limit is reached', async () => {
    const { service, keys } = setup()
    keys.saved.set('gemini-api', 'AIza-good')
    await settings.setSelection('gemini-api', 'gemini-2.5-flash')
    route(
      'POST /v1beta/models/gemini-2.5-flash:streamGenerateContent',
      sse(parts([{ text: 'Partial' }], 'MAX_TOKENS')),
    )
    const { stopReason, events } = await run(service, 'gemini-api')
    expect(stopReason).toBe('max_tokens')
    expect(errorOf(events)?.message).toBe(
      'Gemini reached the output token limit. Increase maxTokens or narrow the request.',
    )
  })
})

describe('OpenRouter API', () => {
  const setup = () => serviceWith(openRouterApiAdapter({ fetch: fetchFor(OPENROUTER) }))

  it('checks the key with GET /api/v1/key, since its model list is public', async () => {
    const { service } = setup()
    route(
      'GET /api/v1/key',
      json(401, { error: { code: 401, message: 'No auth credentials found' } }),
    )
    expect(await service.validateKey('openrouter-api', 'sk-or-bad')).toMatchObject({
      code: 'authentication',
      message: 'OpenRouter rejected the API key. Update it in settings.',
    })
    route('GET /api/v1/key', json(200, { data: { label: 'mine' } }))
    expect(await service.validateKey('openrouter-api', 'sk-or-good')).toBeNull()
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/key', 'GET /api/v1/key'])
    expect(seen.every((r) => r.host === OPENROUTER)).toBe(true)
  })

  it('lists only models that can use tools', async () => {
    const { service, keys } = setup()
    keys.saved.set('openrouter-api', 'sk-or-good')
    route(
      'GET /api/v1/models',
      json(200, {
        data: [
          { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', supported_parameters: ['tools'] },
          { id: 'acme/no-tools', name: 'No tools', supported_parameters: ['temperature'] },
          { id: 'meta/llama:free', name: 'Llama (free)', supported_parameters: ['tools'] },
        ],
      }),
    )
    const listed = await service.models('openrouter-api')
    expect(listed.options.map((option) => [option.id, option.toolSupport])).toEqual([
      ['meta/llama:free', 'supported'],
      ['openai/gpt-5-mini', 'supported'],
    ])
    expect(listed.defaultModel).toBe('openai/gpt-5-mini')
    // Ids with a slash and a colon can be saved.
    expect(await service.setModel('openrouter-api', 'meta/llama:free')).toMatchObject({
      savedModel: 'meta/llama:free',
    })
  })
})

describe.each([
  {
    id: 'ollama',
    factory: ollamaAdapter,
    name: 'Ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    down: "Ollama isn't running. Install it from ollama.com, start it, then check again.",
  },
  {
    id: 'lmstudio',
    factory: lmStudioAdapter,
    name: 'LM Studio',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    down: "LM Studio isn't running. Install it from lmstudio.ai, start its local server, then check again.",
  },
])('$name on this computer', ({ id, factory, name, defaultBaseUrl, down }) => {
  const setup = async () => {
    const created = serviceWith(factory())
    await created.service.setBaseUrl(id, `${origin}/v1`)
    return created
  }
  const models = json(200, { data: [{ id: 'qwen3:8b' }, { id: 'llama3.1:8b' }] })

  it('detects a running server and counts its models, sending no key', async () => {
    const { service } = await setup()
    route('GET /v1/models', models)
    expect(await service.status(id)).toEqual({
      provider: id,
      state: 'ready',
      message: `${name} is running with 2 models.`,
    })
    expect(seen[0]?.headers.authorization).toBeUndefined()
  })

  it('says clearly when nothing is running there', async () => {
    const { service } = await setup()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    expect(await service.status(id)).toEqual({
      provider: id,
      state: 'error',
      message: down,
      failure: { code: 'runtime_unavailable', message: down },
    })
  })

  it('asks the server again on every check, so a stopped server shows as stopped', async () => {
    const { service } = await setup()
    route('GET /v1/models', models)
    expect(await service.status(id)).toMatchObject({ state: 'ready' })
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    expect(await service.status(id)).toMatchObject({ state: 'error', message: down })
  })

  it('says when the server has no models', async () => {
    const { service } = await setup()
    route('GET /v1/models', json(200, { data: [] }))
    expect(await service.status(id)).toMatchObject({
      state: 'error',
      failure: { code: 'model_unavailable' },
    })
  })

  it('lists the models with unknown tool support and a warning, defaulting to the first', async () => {
    const { service } = await setup()
    route('GET /v1/models', models)
    const listed = await service.models(id)
    expect(listed.options.map((option) => [option.id, option.toolSupport])).toEqual([
      ['llama3.1:8b', 'unknown'],
      ['qwen3:8b', 'unknown'],
    ])
    expect(listed.defaultModel).toBe('llama3.1:8b')
    expect(listed.warning).toContain('tool')
    expect(await service.setModel(id, 'qwen3:8b')).toMatchObject({ savedModel: 'qwen3:8b' })
  })

  it(`names ${name}, never Claude, in the agent loop’s own messages`, async () => {
    const { service } = await setup()
    await settings.setSelection(id, 'qwen3:8b')
    route('POST /v1/chat/completions', sse(delta({ content: 'Partial' }), delta({}, 'length')))
    const { events } = await run(service, id)
    expect(errorOf(events)?.message).toBe(
      `${name} reached the output token limit. Increase maxTokens or narrow the request.`,
    )
    expect(JSON.stringify(events)).not.toContain('Claude')
  })

  it('accepts only a loopback http base URL, and goes back to the default', async () => {
    const { service } = serviceWith(factory())
    expect(service.baseUrl(id)).toEqual({ baseUrl: defaultBaseUrl, custom: false })
    for (const bad of [
      'https://api.example.com/v1',
      'http://10.0.0.5:11434/v1',
      'http://192.168.1.20:1234',
      'http://evil.example:11434',
      'http://user:pw@127.0.0.1:11434/v1',
      'http://127.0.0.1:11434/v1?x=1',
      'file:///C:/models',
      'not a url',
    ])
      await expect(service.setBaseUrl(id, bad)).rejects.toThrow('base URL rejected')
    expect(settings.baseUrl(id)).toBeNull()

    expect(await service.setBaseUrl(id, 'http://localhost:9999')).toEqual({
      baseUrl: 'http://localhost:9999/v1',
      custom: true,
    })
    expect(settings.baseUrl(id)).toBe('http://localhost:9999/v1')
    expect(settings.connection).toBe('anthropic-api')
    expect(await service.setBaseUrl(id, null)).toEqual({ baseUrl: defaultBaseUrl, custom: false })
    expect(settings.baseUrl(id)).toBeNull()
  })

  it('refuses a non-loopback base URL even when settings.json was edited by hand', async () => {
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        version: 3,
        connection: 'anthropic-api',
        connections: [{ id, baseUrl: 'http://attacker.example/v1' }],
      }),
    )
    settings = await openSettingsStore(path.join(dir, 'settings.json'))
    const { service } = serviceWith(factory())
    const status = await service.status(id)
    expect(status).toMatchObject({ state: 'error', failure: { code: 'invalid_request' } })
    expect(status.message).toContain('only 127.0.0.1, ::1 and localhost are allowed')
  })
})

describe('the OpenAI-compatible API connections', () => {
  it.each([
    ['openai-api', OPENAI, '/v1', openAIApiAdapter, 'OpenAI'],
    ['openrouter-api', OPENROUTER, '/api/v1', openRouterApiAdapter, 'OpenRouter'],
  ] as const)(
    '%s names its own service in the agent loop’s messages',
    async (id, host, root, factory, name) => {
      const { service, keys } = serviceWith(factory({ fetch: fetchFor(host) }))
      keys.saved.set(id, 'sk-x')
      await settings.setSelection(id, 'some-model')
      route(
        `POST ${root}/chat/completions`,
        sse(delta({ content: 'Partial' }), delta({}, 'length')),
      )
      const { stopReason, events } = await run(service, id)
      expect(stopReason).toBe('max_tokens')
      expect(errorOf(events)?.message).toBe(
        `${name} reached the output token limit. Increase maxTokens or narrow the request.`,
      )
      expect(JSON.stringify(events)).not.toContain('Claude')
    },
  )
})

describe('images and vision per connection', () => {
  /** A tool that returns one PNG with its text. */
  const looker: AgentTool = {
    name: 'look',
    description: 'Look',
    inputSchema: { type: 'object', properties: {} },
    execute: () =>
      Promise.resolve({
        content: 'One picture.',
        images: [{ mime: 'image/png', data: pngShell(4, 4), width: 4, height: 4, label: 'page 1' }],
      }),
  }
  const lookRound = (path: string): void => {
    route(
      `POST ${path}`,
      sse(callDelta('call_1', 'look', {}), delta({}, 'tool_calls')),
      sse(delta({ content: 'A square.' }), delta({}, 'stop')),
    )
  }
  const imageParts = (body: unknown): unknown[] =>
    (body as { messages: { content: unknown }[] }).messages.flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as { type: string }[]).filter((part) => part.type === 'image_url')
        : [],
    )

  it('OpenRouter: the model list says which models read images', async () => {
    const { service, keys } = serviceWith(openRouterApiAdapter({ fetch: fetchFor(OPENROUTER) }))
    keys.saved.set('openrouter-api', 'sk-or-good')
    route(
      'GET /api/v1/models',
      json(200, {
        data: [
          {
            id: 'acme/sees',
            supported_parameters: ['tools'],
            architecture: { input_modalities: ['text', 'image'] },
          },
          {
            id: 'acme/blind',
            supported_parameters: ['tools'],
            architecture: { input_modalities: ['text'] },
          },
          { id: 'acme/unsaid', supported_parameters: ['tools'] },
        ],
      }),
    )
    expect(
      (await service.models('openrouter-api')).options.map((o) => [o.id, o.imageInput]),
    ).toEqual([
      ['acme/blind', false],
      ['acme/sees', true],
      ['acme/unsaid', undefined],
    ])
    await settings.setSelection('openrouter-api', 'acme/sees')
    expect(await service.vision('openrouter-api')).toEqual({
      enabled: true,
      source: 'model',
      setting: false,
      configurable: true,
    })
    await settings.setSelection('openrouter-api', 'acme/blind')
    expect(await service.vision('openrouter-api')).toMatchObject({
      enabled: false,
      source: 'model',
    })
    // The setting only decides for a model the list does not describe.
    await service.setVision('openrouter-api', true)
    expect(await service.vision('openrouter-api')).toMatchObject({ enabled: false, setting: true })
    await settings.setSelection('openrouter-api', 'acme/unsaid')
    expect(await service.vision('openrouter-api')).toMatchObject({
      enabled: true,
      source: 'setting',
    })
  })

  it('OpenAI: documented families decide without a request; others follow the setting', async () => {
    const { service, keys } = serviceWith(openAIApiAdapter({ fetch: fetchFor(OPENAI) }))
    keys.saved.set('openai-api', 'sk-good')
    await settings.setSelection('openai-api', 'gpt-4o')
    expect(await service.vision('openai-api')).toMatchObject({ enabled: true, source: 'model' })
    await settings.setSelection('openai-api', 'gpt-3.5-turbo')
    expect(await service.vision('openai-api')).toMatchObject({ enabled: false, source: 'model' })
    await settings.setSelection('openai-api', 'ft-custom-model')
    expect(await service.vision('openai-api')).toMatchObject({
      enabled: false,
      source: 'setting',
      configurable: true,
    })
    expect(seen).toEqual([])
  })

  it('Ollama: images only once the user says the model can see them', async () => {
    const created = serviceWith(ollamaAdapter())
    const { service } = created
    await service.setBaseUrl('ollama', `${origin}/v1`)
    await settings.setSelection('ollama', 'llava:7b')
    expect(await service.vision('ollama')).toEqual({
      enabled: false,
      source: 'setting',
      setting: false,
      configurable: true,
    })

    lookRound('/v1/chat/completions')
    const blind = await run(service, 'ollama', [looker])
    expect(blind.stopReason).toBe('end_turn')
    const blindBodies = seen.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body)
    expect(blindBodies.flatMap(imageParts)).toEqual([])
    expect(JSON.stringify(blindBodies[1])).toContain('This model cannot see images')

    seen.length = 0
    expect(await service.setVision('ollama', true)).toMatchObject({ enabled: true, setting: true })
    expect(settings.connections.find((c) => c.id === 'ollama')).toMatchObject({ vision: true })
    lookRound('/v1/chat/completions')
    await run(service, 'ollama', [looker])
    const second = seen.filter((r) => r.path === '/v1/chat/completions')[1]?.body as {
      messages: { role: string; content: unknown }[]
    }
    expect(second.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ])
    expect(imageParts(second)).toEqual([
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from(pngShell(4, 4)).toString('base64')}`,
        },
      },
    ])
    // No path, no request to anywhere but this computer.
    expect(seen.every((r) => r.host === origin)).toBe(true)
  })

  it('refuses the setting for a connection that decides itself', async () => {
    const { service } = serviceWith(createAnthropicApiAdapter)
    expect(await service.vision('anthropic-api')).toEqual({
      enabled: true,
      source: 'connection',
      setting: false,
      configurable: false,
    })
    await expect(service.setVision('anthropic-api', false)).rejects.toThrow()
    expect(settings.vision('anthropic-api')).toBe(false)
  })
})
