import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgent, type AgentEvent } from '../../agent'
import { makeSandbox, put, type Sandbox } from '../../permissions/test-support'
import { toolHarness } from '../../tools/test-support'
import { createOpenAICompatClient, type OpenAICompatClientOptions } from './client'
import { OpenAICompatError, openAICompatErrorEvent } from './errors'
import {
  chunk,
  fakeServer,
  json,
  rawSse,
  redirectFetch,
  splitEvent,
  sse,
  toolDelta,
  usageChunk,
  type FakeServer,
} from './test-support'
import { MAX_EVENT_BYTES } from './stream'
import { IMAGE_PLACEHOLDER, TOOL_ERROR_PREFIX } from './translate'

let server: FakeServer
let sb: Sandbox
beforeEach(async () => {
  server = await fakeServer()
  sb = await makeSandbox()
})
afterEach(async () => {
  await server.close()
  await sb.cleanup()
})

const KEY = 'sk-test-SECRET-0123456789'
const client = (overrides: Partial<OpenAICompatClientOptions> = {}) =>
  createOpenAICompatClient({
    baseUrl: server.baseUrl,
    model: 'llama3',
    flavor: 'ollama',
    ...overrides,
  })
const params: MessageCreateParamsNonStreaming = {
  model: 'ignored',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hi' }],
}
async function failure(promise: Promise<unknown>): Promise<OpenAICompatError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(OpenAICompatError)
  return error as OpenAICompatError
}
const finalOf = (c = client(), signal = new AbortController().signal) =>
  c.messages.stream(params, { signal }).finalMessage()

function agentRun(tools = toolHarness(sb), options: Partial<OpenAICompatClientOptions> = {}) {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const agent = createAgent({ client: client(options), tools: Object.values(tools.tools) })
  const run = (prompt = 'Read the notes') =>
    agent.run([{ role: 'user', content: prompt }], {
      signal: controller.signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: (event) => events.push(event),
    })
  return { run, events, controller }
}

describe('openai-compat client', () => {
  it('streams text and returns an Anthropic-shaped message with mapped usage', async () => {
    server.reply(
      sse([
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Hel' }),
        chunk({ content: 'lo' }),
        chunk({}, 'stop'),
        usageChunk(20, 7, 8),
      ]),
    )
    const deltas: string[] = []
    const stream = client({ apiKey: KEY }).messages.stream(
      { ...params, system: [{ type: 'text', text: 'Be brief.' }] },
      { signal: new AbortController().signal },
    )
    stream.on('text', (d) => deltas.push(d))
    const message = await stream.finalMessage()
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(message).toMatchObject({
      role: 'assistant',
      model: 'llama3',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 8 },
    })
    const [request] = server.requests
    expect(request).toMatchObject({ method: 'POST', path: '/v1/chat/completions' })
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(request?.body).toEqual({
      model: 'llama3',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100,
    })
  })

  it('runs a multi-turn tool round-trip through the real agent loop', async () => {
    await put(path.join(sb.root, 'notes.txt'), 'alpha\nbeta\n')
    const args = JSON.stringify({ path: path.join(sb.root, 'notes.txt') })
    server.reply(
      sse([
        chunk({ role: 'assistant', content: 'Reading.' }),
        chunk(toolDelta(0, { id: 'call_abc', name: 'read_file', args: '' })),
        // Arguments arrive in fragments that only parse once assembled.
        chunk(toolDelta(0, { args: args.slice(0, 7) })),
        chunk(toolDelta(0, { args: args.slice(7) })),
        chunk({}, 'tool_calls'),
        usageChunk(),
      ]),
      sse([chunk({ content: 'It says alpha and beta.' }), chunk({}, 'stop'), usageChunk()]),
    )
    const { run, events } = agentRun()
    const result = await run()
    expect(result.stopReason).toBe('end_turn')
    expect(events.filter((e) => e.type === 'tool_result')).toMatchObject([
      { id: 'call_abc', result: { content: expect.stringContaining('alpha') as unknown } },
    ])
    // The canonical transcript stays in Anthropic form.
    expect(result.conversation).toMatchObject([
      { role: 'user' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          {
            type: 'tool_use',
            id: 'call_abc',
            name: 'read_file',
            input: JSON.parse(args) as unknown,
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'It says alpha and beta.' }] },
    ])
    const second = server.requests[1]?.body as { messages: unknown[]; tools: unknown[] }
    expect(second.messages.slice(1)).toMatchObject([
      { role: 'user', content: 'Read the notes' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [
          { id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: args } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_abc',
        content: expect.stringContaining('alpha') as unknown,
      },
    ])
    expect(second.tools).toContainEqual({
      type: 'function',
      function: expect.objectContaining({
        name: 'read_file',
        parameters: expect.objectContaining({ required: ['path'] }) as unknown,
      }) as unknown,
    })
  })

  it('assembles interleaved parallel tool calls and answers them in order', async () => {
    await put(path.join(sb.root, 'a.txt'), 'A')
    await fs.mkdir(path.join(sb.root, 'sub'))
    const a = JSON.stringify({ path: path.join(sb.root, 'a.txt') })
    const b = JSON.stringify({ path: path.join(sb.root, 'sub') })
    server.reply(
      sse([
        chunk(toolDelta(0, { id: 'call_1', name: 'read_file', args: a.slice(0, 5) })),
        chunk(toolDelta(1, { id: 'call_2', name: 'list_dir', args: b.slice(0, 3) })),
        chunk(toolDelta(0, { args: a.slice(5) })),
        chunk(toolDelta(1, { args: b.slice(3) })),
        chunk({}, 'tool_calls'),
      ]),
      sse([chunk({ content: 'Done.' }), chunk({}, 'stop')]),
    )
    const { run, events } = agentRun()
    expect((await run()).stopReason).toBe('end_turn')
    expect(events.filter((e) => e.type === 'tool_use')).toMatchObject([
      { id: 'call_1', name: 'read_file', input: JSON.parse(a) as unknown },
      { id: 'call_2', name: 'list_dir', input: JSON.parse(b) as unknown },
    ])
    const second = server.requests[1]?.body as { messages: unknown[] }
    expect(second.messages.slice(-2)).toMatchObject([
      { role: 'tool', tool_call_id: 'call_1', content: expect.stringContaining('A') as unknown },
      { role: 'tool', tool_call_id: 'call_2' },
    ])
  })

  it('rejects a chunk split over many short data lines past the per-event bound', async () => {
    const lines = Math.ceil(MAX_EVENT_BYTES / 1024) + 16
    server.reply(
      rawSse([
        ...splitEvent({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [] }, lines),
        `data: ${JSON.stringify(chunk({ content: 'ok' }, 'stop'))}\n\ndata: [DONE]\n\n`,
      ]),
    )
    expect(await failure(finalOf())).toMatchObject({
      code: 'protocol',
      message: expect.stringMatching(/oversized stream event/) as unknown,
    })
  }, 30_000)

  it('rejects malformed tool arguments as a protocol error and never runs the tool', async () => {
    const execute = vi.fn(() => Promise.resolve({ content: 'ran' }))
    const stream = sse([
      chunk(toolDelta(0, { id: 'call_x', name: 'read', args: '{"path": "a"' })),
      chunk({}, 'tool_calls'),
    ])
    server.reply(stream)
    const error = await failure(finalOf())
    expect(error.code).toBe('protocol')
    expect(error.message).toMatch(/not valid JSON/)

    // Arguments that parse but are not an object are refused the same way.
    server.reply(
      sse([
        chunk(toolDelta(0, { id: 'call_y', name: 'read', args: '[1]' })),
        chunk({}, 'tool_calls'),
      ]),
    )
    expect((await failure(finalOf())).code).toBe('protocol')

    server.reply(stream)
    const events: AgentEvent[] = []
    const agent = createAgent({
      client: client(),
      tools: [
        {
          name: 'read',
          description: 'r',
          inputSchema: { type: 'object', properties: {} },
          execute,
        },
      ],
    })
    const result = await agent.run([{ role: 'user', content: 'go' }], {
      signal: new AbortController().signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: (e) => events.push(e),
    })
    expect(execute).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'tool_use')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(result.conversation).toHaveLength(1)
  })

  it('returns truncated tool calls as max_tokens so the loop discards them', async () => {
    server.reply(
      sse([
        chunk(toolDelta(0, { id: 'call_t', name: 'read_file', args: '{"pa' })),
        chunk({}, 'length'),
      ]),
    )
    const message = await finalOf()
    expect(message.stop_reason).toBe('max_tokens')
    expect(message.content).toMatchObject([{ type: 'tool_use', input: {} }])
    const { run, events } = agentRun()
    expect((await run()).stopReason).toBe('max_tokens')
    expect(events.map((e) => e.type)).toContain('response_discarded')
    expect(events.some((e) => e.type === 'tool_use')).toBe(false)
  })

  it.each([
    ['stop', [], 'end_turn'],
    ['tool_calls', [toolDelta(0, { id: 'c', name: 'f', args: '{}' })], 'tool_use'],
    // Some local servers finish complete tool calls with "stop".
    ['stop', [toolDelta(0, { id: 'c', name: 'f', args: '' })], 'tool_use'],
    ['length', [], 'max_tokens'],
    ['content_filter', [], 'refusal'],
  ])('maps finish_reason %s to %s', async (finish, deltas, expected) => {
    server.reply(sse([...deltas.map((d) => chunk(d)), chunk({}, finish)]))
    expect((await finalOf()).stop_reason).toBe(expected)
  })

  it('maps provider tool ids to stable transcript-safe ids', async () => {
    const events = [
      chunk(toolDelta(0, { id: 'call:with/odd chars', name: 'f', args: '{}' })),
      chunk(toolDelta(1, { name: 'g', args: '{}' })),
      chunk({}, 'tool_calls'),
    ]
    server.reply(sse(events))
    const first = await finalOf()
    server.reply(sse(events))
    const again = await finalOf()
    const ids = first.content.map((b) => (b.type === 'tool_use' ? b.id : ''))
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(/^call_[0-9a-f]{24}$/)
    expect(new Set(ids).size).toBe(2)
    expect(again.content.map((b) => (b.type === 'tool_use' ? b.id : ''))).toEqual(ids)
  })

  it('translates tool errors, images and thinking blocks safely', async () => {
    server.reply(sse([chunk({ content: 'ok' }), chunk({}, 'stop')]))
    await client()
      .messages.stream(
        {
          ...params,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Look' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                },
              ],
            },
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'secret plan', signature: 'sig' },
                { type: 'tool_use', id: 'toolu_1', name: 'f', input: { a: 1 } },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
                { type: 'text', text: 'And?' },
              ],
            },
          ],
        },
        { signal: new AbortController().signal },
      )
      .finalMessage()
    const body = server.requests[0]?.body as { messages: unknown[] }
    expect(body.messages).toEqual([
      { role: 'user', content: `Look\n\n${IMAGE_PLACEHOLDER}` },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: `${TOOL_ERROR_PREFIX}boom` },
      { role: 'user', content: 'And?' },
    ])
    expect(JSON.stringify(body)).not.toContain('secret plan')
    expect(JSON.stringify(body)).not.toContain('AAAA')
  })

  it('aborts mid-stream through the agent signal and through stream.abort()', async () => {
    const hold: import('./test-support').Handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`)
      // Never finishes.
    }
    server.reply(hold)
    const { run, events, controller } = agentRun()
    const pending = run()
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    })
    controller.abort()
    expect((await pending).stopReason).toBe('aborted')

    const stream = client().messages.stream(params, { signal: new AbortController().signal })
    const seen = new Promise<void>((resolve) =>
      stream.on('text', () => {
        resolve()
      }),
    )
    await seen
    stream.abort()
    expect((await failure(stream.finalMessage())).code).toBe('aborted')
  })

  it.each([
    [
      401,
      { error: { message: `Incorrect API key provided: ${KEY}`, code: 'invalid_api_key' } },
      {},
      'authentication',
    ],
    [403, { error: { message: 'no' } }, {}, 'permission'],
    [
      404,
      { error: { message: 'model "x" not found, try pulling it first' } },
      {},
      'model_unavailable',
    ],
    [400, { error: { code: 'model_not_found', message: 'gone' } }, {}, 'model_unavailable'],
    [402, { error: { code: 402, message: 'credits' } }, {}, 'usage_limit'],
    [429, { error: { code: 'insufficient_quota', message: 'quota' } }, {}, 'usage_limit'],
    [
      429,
      { error: { code: 'rate_limit_exceeded', message: 'slow down' } },
      { 'retry-after': '30' },
      'rate_limit',
    ],
    [400, { error: { code: 'context_length_exceeded', message: 'too long' } }, {}, 'context_limit'],
    [400, { error: "This model's maximum context length is 8192 tokens" }, {}, 'context_limit'],
    [400, { error: { message: 'bad' } }, {}, 'invalid_request'],
    [500, { error: { message: 'oops' } }, {}, 'api'],
    [502, 'Bad gateway', {}, 'api'],
    [503, { error: { message: 'busy' } }, {}, 'overloaded'],
  ] as const)('maps HTTP %i %j to %s', async (status, body, headers, code) => {
    server.reply(json(status, body, headers))
    const error = await failure(finalOf(client({ apiKey: KEY })))
    expect(error.code).toBe(code)
    expect(error.status).toBe(status)
    expect(error.message.length).toBeLessThanOrEqual(300)
    expect(error.message).not.toContain('oops')
    expect(`${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`).not.toContain(KEY)
    if ('retry-after' in headers) {
      const ms = Date.parse(error.resetsAt ?? '') - Date.now()
      expect(ms).toBeGreaterThan(25_000)
      expect(ms).toBeLessThan(35_000)
    }
    expect(openAICompatErrorEvent(error)).toMatchObject({ type: 'error', code })
  })

  it('maps in-stream errors, truncated streams and malformed events', async () => {
    server.reply(
      sse([
        chunk({ content: 'partial' }),
        chunk({}, 'error', { error: { code: 429, message: 'Rate limit', metadata: {} } }),
      ]),
    )
    expect((await failure(finalOf())).code).toBe('rate_limit')
    server.reply(sse([chunk({ content: 'partial' })], { done: false }))
    expect((await failure(finalOf())).code).toBe('network')
    server.reply((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {not json\n\n')
    })
    expect((await failure(finalOf())).code).toBe('protocol')
    server.reply(json(200, { choices: [] }))
    expect((await failure(finalOf())).code).toBe('protocol')
  })

  it('maps connection failures and idle timeouts to network errors', async () => {
    const closed = await fakeServer()
    await closed.close()
    const refused = await failure(finalOf(client({ baseUrl: closed.baseUrl, apiKey: KEY })))
    expect(refused.code).toBe('network')
    expect(JSON.stringify(refused) + refused.message).not.toContain(KEY)

    server.reply((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': waiting\n\n')
    })
    const timedOut = await failure(finalOf(client({ timeoutMs: 150 })))
    expect(timedOut).toMatchObject({
      code: 'network',
      message: expect.stringMatching(/timed out/) as unknown,
    })
  })

  it('refuses redirects instead of following them', async () => {
    server.reply((_req, res) => {
      res.writeHead(307, { Location: 'http://example.com/v1/chat/completions' }).end()
    })
    const error = await failure(finalOf(client({ apiKey: KEY })))
    expect(error.message).toMatch(/redirect/)
    expect(server.requests).toHaveLength(1)
  })

  it('uses max_completion_tokens and the official host for the openai flavor', async () => {
    const seen: string[] = []
    server.reply(sse([chunk({ content: 'hi' }), chunk({}, 'stop')]))
    await finalOf(
      client({
        flavor: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: KEY,
        model: 'gpt-5',
        fetch: redirectFetch(server.origin, seen),
      }),
    )
    expect(seen).toEqual(['https://api.openai.com/v1/chat/completions'])
    expect(server.requests[0]?.body).toMatchObject({ model: 'gpt-5', max_completion_tokens: 100 })
    expect(server.requests[0]?.body).not.toHaveProperty('max_tokens')
  })

  it('validates configuration before any request, without echoing the key', () => {
    expect(() => client({ flavor: 'openai', baseUrl: 'https://api.openai.com/v1' })).toThrow(
      expect.objectContaining({ code: 'authentication' }),
    )
    const badKey = `${KEY}\r\nX-Injected: 1`
    let thrown: unknown
    try {
      client({ apiKey: badKey })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'authentication' })
    expect(String(thrown) + JSON.stringify(thrown)).not.toContain(KEY)
    expect(() => client({ model: ' ' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    )
    expect(server.requests).toHaveLength(0)
  })
})
