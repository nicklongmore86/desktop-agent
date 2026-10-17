import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgent } from '../../agent'
import type { AgentEvent, AgentTool } from '../../agent/types'
import { makeSandbox, put, type Sandbox } from '../../permissions/test-support'
import { toolHarness } from '../../tools/test-support'
import {
  createGeminiClient,
  GEMINI_FREE_TIER_NOTICE,
  GeminiError,
  geminiErrorEvent,
  listGeminiModels,
  validateGeminiKey,
} from './index'
import { GEMINI_HOST, type GeminiRequest, type GeminiResponseChunk } from './types'

const KEY = 'AIzaSyFAKEKEY_for_tests_0123456789abcd'
const MODEL = 'gemini-test'

interface Seen {
  url: string
  method: string
  headers: IncomingMessage['headers']
  body: string
}
type Handler = (req: Seen, res: ServerResponse) => void

/**
 * A local stand-in for generativelanguage.googleapis.com. The injected fetch
 * only rewrites the fixed production origin to this server, so the client
 * builds real production URLs and the test sees exactly what would be sent.
 */
let server: Server
let handlers: Handler[]
let seen: Seen[]
let urls: string[]
let fakeFetch: typeof fetch

beforeEach(async () => {
  handlers = []
  seen = []
  urls = []
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      const request = { url: req.url ?? '', method: req.method ?? '', headers: req.headers, body }
      seen.push(request)
      const handler = handlers.shift()
      if (handler) handler(request, res)
      else res.writeHead(500).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  fakeFetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    urls.push(url.href)
    if (url.origin !== GEMINI_HOST) throw new Error(`unexpected host ${url.origin}`)
    return fetch(`http://127.0.0.1:${String(port)}${url.pathname}${url.search}`, init)
  }
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const sse =
  (...chunks: GeminiResponseChunk[]): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`)
    res.end()
  }
const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
const text = (value: string, finishReason?: string): GeminiResponseChunk => ({
  candidates: [
    {
      content: { role: 'model', parts: [{ text: value }] },
      ...(finishReason ? { finishReason } : {}),
    },
  ],
})
const calls = (
  parts: { name: string; args?: unknown; id?: string; thoughtSignature?: string }[],
): GeminiResponseChunk => ({
  candidates: [
    {
      content: {
        role: 'model',
        parts: parts.map(({ thoughtSignature, ...functionCall }) => ({
          functionCall,
          ...(thoughtSignature ? { thoughtSignature } : {}),
        })),
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 },
})
const bodyOf = (index: number): GeminiRequest =>
  JSON.parse(seen[index]?.body ?? '{}') as GeminiRequest

function client() {
  return createGeminiClient({ apiKey: KEY, model: MODEL, fetch: fakeFetch })
}
function stream(signal = new AbortController().signal) {
  const s = client().messages.stream(
    { model: 'ignored', max_tokens: 64, messages: [{ role: 'user', content: 'Hi' }] },
    { signal },
  )
  const deltas: string[] = []
  s.on('text', (delta) => deltas.push(delta))
  return { s, deltas }
}

describe('Gemini client', () => {
  it('streams text to the fixed endpoint with the key only in a header', async () => {
    handlers.push(
      sse(text('Hel'), text('lo'), {
        ...text('!', 'STOP'),
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
        modelVersion: 'gemini-test-001',
      }),
    )
    const { s, deltas } = stream()
    const message = await s.finalMessage()
    expect(deltas).toEqual(['Hel', 'lo', '!'])
    expect(message).toMatchObject({
      role: 'assistant',
      model: 'gemini-test-001',
      content: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 5 },
    })
    expect(urls).toEqual([`${GEMINI_HOST}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`])
    expect(seen[0]?.headers['x-goog-api-key']).toBe(KEY)
    expect(seen[0]?.method).toBe('POST')
    expect(urls.join()).not.toContain(KEY)
    expect(bodyOf(0)).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      generationConfig: { maxOutputTokens: 64 },
    })
  })

  it('maps refusals and blocked prompts', async () => {
    handlers.push(
      sse(text('', 'SAFETY')),
      sse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
    )
    expect((await stream().s.finalMessage()).stop_reason).toBe('refusal')
    expect((await stream().s.finalMessage()).stop_reason).toBe('refusal')
  })

  it('rejects a stream that ends without a finish reason', async () => {
    handlers.push(sse(text('partial')))
    await expect(stream().s.finalMessage()).rejects.toMatchObject({ code: 'network' })
  })

  it('aborts mid-stream', async () => {
    handlers.push((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(text('first'))}\n\n`)
      // Never finishes.
    })
    const controller = new AbortController()
    const { s, deltas } = stream(controller.signal)
    await vi.waitFor(() => {
      expect(deltas).toEqual(['first'])
    })
    controller.abort()
    await expect(s.finalMessage()).rejects.toMatchObject({ code: 'aborted' })
  })

  it.each([
    [
      400,
      {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: `API key not valid: ${KEY}`,
          details: [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
          ],
        },
      },
      'authentication',
    ],
    [403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no' } }, 'permission'],
    [404, { error: { code: 404, status: 'NOT_FOUND', message: 'no model' } }, 'model_unavailable'],
    [
      429,
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: `quota for key ${KEY}`,
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
        },
      },
      'rate_limit',
    ],
    [500, { error: { code: 500, status: 'INTERNAL', message: KEY } }, 'api'],
    [503, { error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } }, 'overloaded'],
  ] as const)('maps HTTP %i to %s without leaking the key', async (status, body, code) => {
    handlers.push(json(status, body))
    const error = await stream()
      .s.finalMessage()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GeminiError)
    const event = geminiErrorEvent(error)
    expect(event.code).toBe(code)
    if (status === 429) expect(Date.parse(event.resetsAt ?? '')).toBeGreaterThan(Date.now())
    expect(JSON.stringify(event)).not.toContain(KEY)
    expect(JSON.stringify(error)).not.toContain(KEY)
    expect(String(error)).not.toContain(KEY)
  })

  it('maps an error sent inside the stream', async () => {
    handlers.push(
      sse(text('a'), { error: { code: 503, status: 'UNAVAILABLE', message: 'x' } } as never),
    )
    await expect(stream().s.finalMessage()).rejects.toMatchObject({ code: 'overloaded' })
  })

  it('reports network failures and refuses redirects', async () => {
    const offline = createGeminiClient({
      apiKey: KEY,
      model: MODEL,
      fetch: () => Promise.reject(new TypeError(`fetch failed for ${KEY}`)),
    })
    const s = offline.messages.stream(
      { model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] },
      { signal: new AbortController().signal },
    )
    const error = await s.finalMessage().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'network' })
    expect((error as Error).message).not.toContain(KEY)

    handlers.push((_req, res) => {
      res.writeHead(302, { location: 'https://example.com/steal' }).end()
    })
    await expect(stream().s.finalMessage()).rejects.toMatchObject({ code: 'network' })
    expect(seen).toHaveLength(1)
  })

  it('rejects malformed model names before any request', async () => {
    const bad = createGeminiClient({ apiKey: KEY, model: '../evil', fetch: fakeFetch })
    const s = bad.messages.stream(
      { model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] },
      { signal: new AbortController().signal },
    )
    await expect(s.finalMessage()).rejects.toMatchObject({ code: 'invalid_request' })
    expect(seen).toHaveLength(0)
  })
})

describe('Gemini client in the agent loop', () => {
  let sb: Sandbox
  beforeEach(async () => {
    sb = await makeSandbox()
  })
  afterEach(async () => {
    await sb.cleanup()
  })

  function run(tools: AgentTool[], signal = new AbortController().signal) {
    const events: AgentEvent[] = []
    const agent = createAgent({ client: client(), tools, model: MODEL })
    const result = agent.run([{ role: 'user', content: 'Summarise my notes' }], {
      signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: (event) => events.push(event),
    })
    return { result, events }
  }

  it('runs a multi-turn tool round trip over a granted folder', async () => {
    await put(path.join(sb.root, 'notes.txt'), 'buy milk')
    const tools = Object.values(toolHarness(sb).tools)
    handlers.push(
      sse(
        text('Looking.'),
        calls([
          { id: 'g1', name: 'list_dir', args: { path: sb.root }, thoughtSignature: 'SIG-ONE' },
        ]),
      ),
      sse(
        calls([
          {
            id: 'g2',
            name: 'read_file',
            args: { path: path.join(sb.root, 'notes.txt') },
            thoughtSignature: 'SIG-TWO',
          },
        ]),
      ),
      sse(text('You need to buy milk.', 'STOP')),
    )
    const { result, events } = run(tools)
    const { conversation, stopReason } = await result
    expect(stopReason).toBe('end_turn')

    // Turn 1: system prompt, function declarations, no parameters for an empty schema.
    const first = bodyOf(0)
    expect(first.systemInstruction?.parts[0]?.text).toContain('desktop file assistant')
    const declarations = first.tools?.[0]?.functionDeclarations ?? []
    expect(declarations.map((d) => d.name)).toEqual(tools.map((t) => t.name))
    expect(declarations.find((d) => d.name === 'list_granted_folders')?.parameters).toBeUndefined()
    expect(JSON.stringify(first.tools)).not.toContain('additionalProperties')

    // Turn 3 replays both calls with Gemini's ids and signatures, and the real tool output.
    const third = bodyOf(2)
    expect(third.contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user'])
    expect(third.contents[1]?.parts).toEqual([
      { text: 'Looking.' },
      {
        functionCall: { id: 'g1', name: 'list_dir', args: { path: sb.root } },
        thoughtSignature: 'SIG-ONE',
      },
    ])
    expect(third.contents[2]?.parts[0]?.functionResponse).toMatchObject({
      id: 'g1',
      name: 'list_dir',
      response: { output: expect.stringContaining('notes.txt') as unknown },
    })
    expect(third.contents[3]?.parts[0]).toMatchObject({ thoughtSignature: 'SIG-TWO' })
    expect(third.contents[4]?.parts[0]?.functionResponse).toMatchObject({
      id: 'g2',
      name: 'read_file',
      response: { output: expect.stringContaining('buy milk') as unknown },
    })

    // The persisted transcript is plain Anthropic format with no Gemini signatures in it.
    expect(conversation).toHaveLength(6)
    expect(JSON.stringify(conversation)).not.toContain('SIG-')
    expect(JSON.stringify(events)).not.toContain('SIG-')
    const toolIds = events.flatMap((e) => (e.type === 'tool_use' ? [e.id] : []))
    expect(toolIds).toHaveLength(2)
    for (const id of toolIds) expect(id).toMatch(/^toolu_gemini_[0-9a-f]{24}$/)
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual([
      'Looking.',
      'You need to buy milk.',
    ])
  })

  it('runs several function calls from one turn and answers them together', async () => {
    const execute = vi.fn((input: { path: string }) =>
      Promise.resolve({ content: `read ${input.path}` }),
    )
    const tool: AgentTool = {
      name: 'read',
      description: 'Read',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute,
    }
    handlers.push(
      sse(
        calls([
          { name: 'read', args: { path: 'a' }, thoughtSignature: 'S' },
          { name: 'read', args: { path: 'b' } },
        ]),
      ),
      sse(text('Both read.', 'STOP')),
    )
    const { result } = run([tool])
    expect((await result).stopReason).toBe('end_turn')
    expect(execute).toHaveBeenCalledTimes(2)
    const second = bodyOf(1)
    expect(second.contents[1]?.parts).toEqual([
      { functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'S' },
      { functionCall: { name: 'read', args: { path: 'b' } } },
    ])
    expect(second.contents[2]?.parts).toEqual([
      { functionResponse: { name: 'read', response: { output: 'read a' } } },
      { functionResponse: { name: 'read', response: { output: 'read b' } } },
    ])
  })

  it.each([
    ['string arguments', calls([{ name: 'read', args: '{"path":' }])],
    ['array arguments', calls([{ name: 'read', args: ['a'] }])],
    ['a nameless call', calls([{ name: '', args: {} }])],
    [
      'MALFORMED_FUNCTION_CALL',
      { candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] },
    ],
    [
      'calls cut off by the token limit',
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'read', args: {} } }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      },
    ],
  ] as const)('never executes %s', async (_label, chunk) => {
    const execute = vi.fn(() => Promise.resolve({ content: 'ok' }))
    handlers.push(sse(chunk as GeminiResponseChunk))
    const { result, events } = run([
      {
        name: 'read',
        description: 'Read',
        inputSchema: { type: 'object', properties: {} },
        execute,
      },
    ])
    const { stopReason, conversation } = await result
    expect(execute).not.toHaveBeenCalled()
    expect(stopReason).not.toBe('tool_use')
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(JSON.stringify(conversation)).not.toContain('tool_use')
  })

  it('cancels mid-stream', async () => {
    handlers.push((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(text('Thinking about it'))}\n\n`)
    })
    const controller = new AbortController()
    const { result, events } = run([], controller.signal)
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    })
    controller.abort()
    expect((await result).stopReason).toBe('aborted')
  })
})

describe('listGeminiModels', () => {
  it('pages through models.list and keeps generateContent models', async () => {
    handlers.push(
      json(200, {
        models: [
          {
            name: 'models/gemini-a',
            displayName: 'Gemini A',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
            inputTokenLimit: 1000,
            outputTokenLimit: 100,
          },
          { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'next',
      }),
      json(200, {
        models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }],
      }),
    )
    const models = await listGeminiModels(KEY, { fetch: fakeFetch })
    expect(models).toEqual([
      { id: 'gemini-a', displayName: 'Gemini A', inputTokenLimit: 1000, outputTokenLimit: 100 },
      { id: 'gemini-b', displayName: 'gemini-b' },
    ])
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ['GET', '/v1beta/models?pageSize=1000'],
      ['GET', '/v1beta/models?pageSize=1000&pageToken=next'],
    ])
    expect(seen.every((s) => s.headers['x-goog-api-key'] === KEY)).toBe(true)
    expect(urls.join()).not.toContain(KEY)
  })

  it('validates a key with models.list only', async () => {
    handlers.push(
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
    const result = await validateGeminiKey(KEY, { fetch: fakeFetch })
    expect(result).toMatchObject({ ok: false, error: { code: 'authentication' } })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).not.toContain('generateContent')
    await expect(listGeminiModels(' ', { fetch: fakeFetch })).rejects.toMatchObject({
      code: 'authentication',
    })
  })

  it('exports the free-tier data notice with its source', () => {
    expect(GEMINI_FREE_TIER_NOTICE.text).toMatch(/improve its products/)
    expect(GEMINI_FREE_TIER_NOTICE.links[0].url).toBe(
      'https://ai.google.dev/gemini-api/docs/pricing',
    )
  })
})
