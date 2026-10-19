import path from 'node:path'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgent, type AgentEvent } from '../../agent'
import { makeSandbox, put, type Sandbox } from '../../permissions/test-support'
import { toolHarness } from '../../tools/test-support'
import { OpenAICompatError, openAICompatErrorEvent } from '../openai-compat/errors'
import {
  fakeServer,
  json,
  redirectFetch,
  responsesEvents as ev,
  responsesSse,
  rawSse,
  splitEvent,
  type FakeServer,
  type Handler,
} from '../openai-compat/test-support'
import { MAX_EVENT_BYTES, MAX_STREAM_BYTES } from '../openai-compat/stream'
import { TOOL_ERROR_PREFIX } from '../openai-compat/translate'
import { createChatGPTResponsesClient, type ChatGPTResponsesClientOptions } from './client'
import { MANAGE_USAGE_URL, ResponsesError } from './errors'
import { ALLOWED_BODY_KEYS, OMITTED_BODY_KEYS, TOOL_NAMESPACE } from './translate'

let server: FakeServer
let sb: Sandbox
let seen: string[]
beforeEach(async () => {
  server = await fakeServer()
  sb = await makeSandbox()
  seen = []
})
afterEach(async () => {
  await server.close()
  await sb.cleanup()
})

const TOKEN = 'eyJhbGciOi.SECRET-access-token-0123456789.sig'
const client = (overrides: Partial<ChatGPTResponsesClientOptions> = {}) =>
  createChatGPTResponsesClient({
    model: 'gpt-6.1-sol',
    getAccessToken: () => Promise.resolve(TOKEN),
    // The client always targets https://api.openai.com; tests rewrite it onto the fake server.
    fetch: redirectFetch(server.origin, seen),
    ...overrides,
  })
const params: MessageCreateParamsNonStreaming = {
  model: 'ignored',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hi' }],
}
const tool = (name: string) => ({
  name,
  input_schema: { type: 'object' as const, properties: {} },
})
/** Offers `read`, `f` and `g`: the model may call only offered tools. */
const withTools: MessageCreateParamsNonStreaming = {
  ...params,
  tools: [tool('read'), tool('f'), tool('g')],
}
/** A completed call in this client's namespace; `namespace: null` sends none. */
const call = (
  fields: Omit<Parameters<typeof ev.call>[0], 'namespace'> & { namespace?: string | null },
) => {
  const { namespace = TOOL_NAMESPACE, ...rest } = fields
  return ev.call({ ...rest, ...(namespace === null ? {} : { namespace }) })
}
async function failure(promise: Promise<unknown>): Promise<OpenAICompatError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(OpenAICompatError)
  return error as OpenAICompatError
}
const finalOf = (c = client(), p = params) =>
  c.messages.stream(p, { signal: new AbortController().signal }).finalMessage()
const leaks = (error: unknown): boolean => {
  const e = error as Error
  return `${e.message} ${e.stack ?? ''} ${JSON.stringify(e)} ${String(e)}`.includes(TOKEN)
}

function agentRun(
  tools = toolHarness(sb).tools,
  options: Partial<ChatGPTResponsesClientOptions> = {},
) {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const agent = createAgent({
    client: client(options),
    tools: Object.values(tools),
    errorEvent: openAICompatErrorEvent,
  })
  const run = (prompt = 'Read the notes') =>
    agent.run([{ role: 'user', content: prompt }], {
      signal: controller.signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: (event) => events.push(event),
    })
  return { run, events, controller }
}

describe('openai-responses client', () => {
  it('streams text and sends the minimal stateless request to the official host', async () => {
    server.reply(
      responsesSse([
        ev.created(),
        ev.textDelta('Hel'),
        ev.textDelta('lo'),
        ev.message('Hello'),
        ev.completed({ input: 20, output: 7, cached: 8 }),
      ]),
    )
    const deltas: string[] = []
    const stream = client().messages.stream(
      { ...params, system: [{ type: 'text', text: 'Be brief.' }] },
      { signal: new AbortController().signal },
    )
    stream.on('text', (d) => deltas.push(d))
    const message = await stream.finalMessage()
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(message).toMatchObject({
      role: 'assistant',
      model: 'gpt-6.1-sol',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 8 },
    })
    expect(seen).toEqual(['https://api.openai.com/v1/responses'])
    const [request] = server.requests
    expect(request).toMatchObject({ method: 'POST', path: '/v1/responses' })
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(request?.headers.accept).toBe('text/event-stream')
    expect(request?.body).toEqual({
      model: 'gpt-6.1-sol',
      instructions: 'Be brief.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
      store: false,
      stream: true,
    })
  })

  it('runs a tool call and its result through the real agent loop with a granted folder', async () => {
    await put(path.join(sb.root, 'notes.txt'), 'alpha\nbeta\n')
    const args = JSON.stringify({ path: path.join(sb.root, 'notes.txt') })
    const getAccessToken = vi.fn(() => Promise.resolve(TOKEN))
    server.reply(
      responsesSse([
        ev.textDelta('Reading.'),
        ev.message('Reading.'),
        ev.call({
          call_id: 'call_abc',
          name: 'read_file',
          arguments: args,
          namespace: TOOL_NAMESPACE,
        }),
        ev.completed(),
      ]),
      responsesSse([
        ev.textDelta('It says alpha and beta.'),
        ev.message('It says alpha and beta.'),
        ev.completed(),
      ]),
    )
    const { run, events } = agentRun(toolHarness(sb).tools, { getAccessToken })
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
    // The token is read for every request; the second turn resends the whole history.
    expect(getAccessToken).toHaveBeenCalledTimes(2)
    const second = server.requests[1]?.body as Record<string, unknown> & {
      input: unknown[]
      tools: { type: string; name: string; tools: unknown[] }[]
    }
    expect(second.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read the notes' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
      {
        type: 'function_call',
        call_id: 'call_abc',
        name: 'read_file',
        arguments: args,
        namespace: TOOL_NAMESPACE,
      },
      {
        type: 'function_call_output',
        call_id: 'call_abc',
        output: expect.stringContaining('alpha') as unknown,
      },
    ])
    expect(second).not.toHaveProperty('previous_response_id')
    expect(second.store).toBe(false)
    expect(second.tools).toHaveLength(1)
    expect(second.tools[0]).toMatchObject({ type: 'namespace', name: TOOL_NAMESPACE })
    expect(second.tools[0]?.tools).toContainEqual({
      type: 'function',
      name: 'read_file',
      description: expect.any(String) as unknown,
      parameters: expect.objectContaining({ required: ['path'] }) as unknown,
      strict: false,
    })
  })

  it('never sends an omitted field, a system item or server state', async () => {
    expect(ALLOWED_BODY_KEYS.filter((k) => OMITTED_BODY_KEYS.includes(k))).toEqual([])
    server.reply(responsesSse([ev.message('ok'), ev.completed()]))
    await finalOf(client(), {
      model: 'ignored',
      max_tokens: 4096,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 5,
      stop_sequences: ['END'],
      metadata: { user_id: 'u1' },
      system: 'Rules',
      tools: [
        { name: 'f', input_schema: { type: 'object', properties: {} } },
        // A hosted tool: never offered on this route.
        { type: 'web_search_20250305', name: 'web_search' },
      ],
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    })
    const body = server.requests[0]?.body as Record<string, unknown>
    for (const key of Object.keys(body)) expect(ALLOWED_BODY_KEYS).toContain(key)
    for (const key of OMITTED_BODY_KEYS) expect(body).not.toHaveProperty(key)
    expect(body).toMatchObject({ store: false, stream: true, instructions: 'Rules' })
    expect(JSON.stringify(body)).not.toMatch(/"role":"(system|developer)"/)
    expect(JSON.stringify(body)).not.toContain('web_search')
    expect(body.input).toHaveLength(3)
  })

  it('translates tool errors, images and thinking blocks safely', async () => {
    server.reply(responsesSse([ev.message('ok'), ev.completed()]))
    await finalOf(client(), {
      ...params,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
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
    })
    const body = server.requests[0]?.body as { input: unknown[] }
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: expect.stringMatching(/^Look\n\n\[Image omitted/) as unknown,
          },
        ],
      },
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'f',
        arguments: '{"a":1}',
        namespace: TOOL_NAMESPACE,
      },
      { type: 'function_call_output', call_id: 'toolu_1', output: `${TOOL_ERROR_PREFIX}boom` },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'And?' }] },
    ])
    expect(JSON.stringify(body)).not.toContain('secret plan')
    expect(JSON.stringify(body)).not.toContain('AAAA')
  })

  it('maps a usage limit that arrives mid-stream as response.failed, after text', async () => {
    server.reply(
      responsesSse([
        ev.textDelta('Partial'),
        ev.failed('subscription_sharing_usage_limit_exceeded', `limit for ${TOKEN}`),
      ]),
    )
    const deltas: string[] = []
    const stream = client().messages.stream(params, { signal: new AbortController().signal })
    stream.on('text', (d) => deltas.push(d))
    const error = await failure(stream.finalMessage())
    expect(deltas).toEqual(['Partial'])
    expect(error).toBeInstanceOf(ResponsesError)
    expect(error).toMatchObject({ code: 'usage_limit', retryable: false })
    expect(error.resetsAt).toBeUndefined()
    expect(error.message).toContain(MANAGE_USAGE_URL)
    expect(leaks(error)).toBe(false)

    // Through the agent loop: an error event, no partial turn kept.
    server.reply(
      responsesSse([ev.textDelta('Partial'), ev.failed('subscription_sharing_usage_unavailable')]),
    )
    const { run, events } = agentRun()
    const result = await run()
    expect(result.stopReason).toBe('overloaded')
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'overloaded' })
    expect(result.conversation).toHaveLength(1)
  })

  it('maps stream error events, endings without response.completed and malformed events', async () => {
    server.reply(
      responsesSse([{ type: 'error', code: 'context_length_exceeded', message: 'long' }]),
    )
    expect((await failure(finalOf())).code).toBe('context_limit')
    // Only response.completed is success: a stream that just stops is a failure.
    server.reply(responsesSse([ev.textDelta('Hello'), ev.message('Hello')]))
    expect(await failure(finalOf())).toMatchObject({
      code: 'network',
      message: expect.stringMatching(/ended unexpectedly/) as unknown,
    })
    server.reply((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {not json\n\n')
    })
    expect((await failure(finalOf())).code).toBe('protocol')
    server.reply(json(200, { output: [] }))
    expect((await failure(finalOf())).code).toBe('protocol')
    server.reply(json(200, { error: { code: 'subscription_sharing_user_not_eligible' } }))
    expect((await failure(finalOf())).code).toBe('plan_not_entitled')
  })

  it('ignores events after the terminal event', async () => {
    server.reply(responsesSse([ev.message('Done'), ev.completed(), ev.failed('server_error')]))
    expect((await finalOf()).content).toMatchObject([{ type: 'text', text: 'Done' }])
  })

  it('uses response.completed output when no items were streamed', async () => {
    const completed = ev.completed()
    const response = {
      ...completed.response,
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'From output' }],
        },
      ],
    }
    server.reply(responsesSse([{ type: 'response.completed', response }]))
    expect((await finalOf()).content).toMatchObject([{ type: 'text', text: 'From output' }])
  })

  it.each([
    ['max_output_tokens', 'max_tokens'],
    ['content_filter', 'refusal'],
  ])('maps response.incomplete %s to %s', async (reason, expected) => {
    server.reply(responsesSse([ev.textDelta('Par'), ev.incomplete(reason)]))
    const message = await finalOf()
    expect(message.stop_reason).toBe(expected)
    expect(message.content).toMatchObject([{ type: 'text', text: 'Par' }])
  })

  it('discards tool calls in an incomplete response instead of running them', async () => {
    const execute = vi.fn(() => Promise.resolve({ content: 'ran' }))
    server.reply(
      responsesSse([
        call({ call_id: 'call_t', name: 'read', arguments: '{"pa' }),
        ev.incomplete('max_output_tokens'),
      ]),
    )
    const { run, events } = agentRun({
      read: {
        name: 'read',
        description: 'r',
        inputSchema: { type: 'object', properties: {} },
        execute,
      },
    })
    expect((await run()).stopReason).toBe('max_tokens')
    expect(events.map((e) => e.type)).toContain('response_discarded')
    expect(execute).not.toHaveBeenCalled()
  })

  it('maps a refusal-only message to refusal', async () => {
    server.reply(
      responsesSse([
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'refusal', refusal: 'No.' }],
          },
        },
        ev.completed(),
      ]),
    )
    expect((await finalOf()).stop_reason).toBe('refusal')
  })

  it.each([
    [
      'arguments that are not JSON',
      { call_id: 'c1', name: 'read', arguments: '{"path": "a"' },
      /not valid JSON/,
    ],
    [
      'arguments that are not an object',
      { call_id: 'c1', name: 'read', arguments: '[1]' },
      /not valid JSON/,
    ],
    ['no call id', { name: 'read', arguments: '{}' }, /without an id/],
    ['no name', { call_id: 'c1', arguments: '{}' }, /did not offer/],
    [
      'no namespace',
      { call_id: 'c1', name: 'read', arguments: '{}', namespace: null },
      /did not offer/,
    ],
    [
      'a name that was not offered',
      { call_id: 'c1', name: 'write_file', arguments: '{}' },
      /did not offer/,
    ],
    [
      'an unfinished status',
      { call_id: 'c1', name: 'read', arguments: '{}', status: 'incomplete' },
      /unfinished/,
    ],
    [
      'another namespace',
      { call_id: 'c1', name: 'read', arguments: '{}', namespace: 'other' },
      /did not offer/,
    ],
  ])('never runs a tool call with %s', async (_label, fields, message) => {
    const execute = vi.fn(() => Promise.resolve({ content: 'ran' }))
    const events = [call(fields), ev.completed()]
    server.reply(responsesSse(events))
    const error = await failure(finalOf(client(), withTools))
    expect(error).toMatchObject({
      code: 'protocol',
      message: expect.stringMatching(message) as unknown,
    })

    server.reply(responsesSse(events))
    const { run, events: seenEvents } = agentRun({
      read: {
        name: 'read',
        description: 'r',
        inputSchema: { type: 'object', properties: {} },
        execute,
      },
    })
    const result = await run()
    expect(execute).not.toHaveBeenCalled()
    expect(seenEvents.some((e) => e.type === 'tool_use')).toBe(false)
    expect(seenEvents.at(-1)).toMatchObject({ type: 'error', code: 'protocol' })
    expect(result.conversation).toHaveLength(1)
  })

  it('maps provider call ids to stable transcript-safe ids', async () => {
    const events = [
      call({ call_id: 'call:with/odd chars', name: 'f', arguments: '{}' }),
      call({ call_id: 'call_ok', name: 'g', arguments: '{}' }),
      ev.completed(),
    ]
    server.reply(responsesSse(events))
    const first = await finalOf(client(), withTools)
    server.reply(responsesSse(events))
    const again = await finalOf(client(), withTools)
    const ids = first.content.map((b) => (b.type === 'tool_use' ? b.id : ''))
    expect(ids[0]).toMatch(/^call_[0-9a-f]{24}$/)
    expect(ids[1]).toBe('call_ok')
    expect(first.stop_reason).toBe('tool_use')
    expect(again.content.map((b) => (b.type === 'tool_use' ? b.id : ''))).toEqual(ids)
  })

  it.each([
    [
      429,
      { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'x' } },
      'usage_limit',
      false,
    ],
    [
      403,
      { error: { code: 'subscription_sharing_user_not_eligible', message: 'x' } },
      'plan_not_entitled',
      false,
    ],
    [
      503,
      { error: { code: 'subscription_sharing_usage_unavailable', message: 'x' } },
      'overloaded',
      true,
    ],
    [
      503,
      { error: { code: 'subscription_sharing_user_unavailable', message: 'x' } },
      'overloaded',
      true,
    ],
    [
      400,
      {
        error: {
          code: 'subscription_sharing_unsupported_capability',
          param: 'tools[0].type',
          message: 'x',
        },
      },
      'invalid_request',
      false,
    ],
    [
      403,
      { error: { code: 'subscription_sharing_route_not_supported', message: 'x' } },
      'api',
      false,
    ],
    [
      401,
      { error: { code: 'subscription_sharing_invalid_user', message: 'x' } },
      'auth_expired',
      false,
    ],
    [
      403,
      { error: { code: 'chatpass_v2_scope_not_authorized', message: 'x' } },
      'auth_expired',
      false,
    ],
    [
      403,
      { error: { code: 'chatpass_v2_invalid_authorization_context', message: 'x' } },
      'auth_expired',
      false,
    ],
    // Direct-route admission: `{detail}` and no stable code.
    [401, { detail: `token ${TOKEN} rejected` }, 'auth_expired', false],
    [403, { detail: 'region not permitted' }, 'permission', false],
    [503, { detail: 'direct routing unavailable' }, 'overloaded', true],
    [400, { error: { code: 'context_length_exceeded', message: 'x' } }, 'context_limit', false],
    [404, { error: { code: 'model_not_found', message: 'x' } }, 'model_unavailable', false],
    [429, { error: { code: 'rate_limit_exceeded', message: 'x' } }, 'rate_limit', true],
    [400, { error: { message: 'bad' } }, 'invalid_request', false],
    [500, 'oops', 'api', true],
  ] as const)('maps HTTP %i %j to %s', async (status, body, code, retryable) => {
    server.reply(json(status, body, { 'retry-after': '30', 'x-request-id': 'req_abc123' }))
    const error = await failure(finalOf())
    expect(error).toBeInstanceOf(ResponsesError)
    expect(error).toMatchObject({ code, status, retryable, requestId: 'req_abc123' })
    expect(error.message.length).toBeLessThanOrEqual(300)
    expect(error.message).not.toMatch(/provider text|oops|region not permitted|routing unavailable/)
    expect(leaks(error)).toBe(false)
    expect(openAICompatErrorEvent(error)).toMatchObject({ type: 'error', code })
    if (code === 'usage_limit') {
      // The docs say not to infer a reset time from this code, even with a retry-after.
      expect(error.resetsAt).toBeUndefined()
      expect(error.message).toContain(MANAGE_USAGE_URL)
    }
    if (code === 'plan_not_entitled')
      expect(error.message).toMatch(/Needs ChatGPT Plus or Pro.*API key/)
    if (code === 'auth_expired') expect(error.message).toMatch(/[Ss]ign in/)
    if (typeof body === 'object' && 'error' in body && 'param' in body.error)
      expect((error as ResponsesError).param).toBe('tools[0].type')
    expect(server.requests).toHaveLength(1)
  })

  it('keeps provider text out of error.param', async () => {
    server.reply(
      json(400, {
        error: { code: 'subscription_sharing_unsupported_capability', param: `see ${TOKEN}` },
      }),
    )
    const error = (await failure(finalOf())) as ResponsesError
    expect(error.param).toBeUndefined()
    expect(leaks(error)).toBe(false)
  })

  it('refuses redirects instead of following them', async () => {
    server.reply((_req, res) => {
      res.writeHead(307, { Location: 'https://chatgpt.com/backend-api/responses' }).end()
    })
    const error = await failure(finalOf())
    expect(error.message).toMatch(/redirect/)
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual(['https://api.openai.com/v1/responses'])
  })

  it('keeps the token out of errors, URLs and logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A token source that fails with the token in its message.
      const sourceFailure = await failure(
        finalOf(
          client({
            getAccessToken: () => Promise.reject(new Error(`refresh failed for ${TOKEN}`)),
          }),
        ),
      )
      expect(sourceFailure.code).toBe('auth_expired')
      expect(leaks(sourceFailure)).toBe(false)

      // A token with a header-injection attempt is refused before any request.
      const injected = await failure(
        finalOf(client({ getAccessToken: () => Promise.resolve(`${TOKEN}\r\nX-Injected: 1`) })),
      )
      expect(injected.code).toBe('auth_expired')
      expect(leaks(injected)).toBe(false)
      expect(server.requests).toHaveLength(0)

      // An OpenAICompatError from the token source passes through unchanged.
      const typed = new OpenAICompatError('network', 'Could not refresh the ChatGPT sign-in.')
      expect(await failure(finalOf(client({ getAccessToken: () => Promise.reject(typed) })))).toBe(
        typed,
      )

      // Connection failures carry no socket details or token.
      const closed = await fakeServer()
      await closed.close()
      const refused = await failure(finalOf(client({ fetch: redirectFetch(closed.origin, seen) })))
      expect(refused.code).toBe('network')
      expect(leaks(refused)).toBe(false)

      server.reply(json(401, { error: { message: `Bad token ${TOKEN}` } }))
      expect(leaks(await failure(finalOf()))).toBe(false)
      expect(seen.some((url) => url.includes(TOKEN))).toBe(false)
      for (const call of [...log.mock.calls, ...warn.mock.calls])
        expect(String(call)).not.toContain(TOKEN)
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
  })

  it('aborts mid-stream through the agent signal and through stream.abort()', async () => {
    const hold: Handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(ev.textDelta('partial'))}\n\n`)
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
    await new Promise<void>((resolve) =>
      stream.on('text', () => {
        resolve()
      }),
    )
    stream.abort()
    expect((await failure(stream.finalMessage())).code).toBe('aborted')
  })

  it('times out an idle stream', async () => {
    server.reply((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': waiting\n\n')
    })
    expect(await failure(finalOf(client({ timeoutMs: 150 })))).toMatchObject({
      code: 'network',
      message: expect.stringMatching(/timed out/) as unknown,
    })
  })

  it.each([
    ' ',
    'gpt 6',
    'gpt/6',
    '../responses',
    'gpt-6?x=1',
    'gpt-6#frag',
    'gpt-6\nX-Injected: 1',
    'gpt\u20116',
    'a'.repeat(257),
  ])('refuses the model %j before any request', (model) => {
    expect(() => client({ model })).toThrow(expect.objectContaining({ code: 'invalid_request' }))
    expect(server.requests).toHaveLength(0)
  })

  it('accepts a model slug as the model list returns it', async () => {
    server.reply(responsesSse([ev.message('ok'), ev.completed()]))
    await finalOf(client({ model: ' gpt-6.1-sol:2026_10 ' }))
    expect(server.requests[0]?.body).toMatchObject({ model: 'gpt-6.1-sol:2026_10' })
  })

  it('never sends a conversation with an orphaned tool result', async () => {
    server.reply(responsesSse([ev.message('ok'), ev.completed()]))
    const error = await failure(
      finalOf(client(), {
        ...withTools,
        messages: [
          { role: 'user', content: 'Go' },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'r' }] },
        ],
      }),
    )
    expect(error).toMatchObject({ code: 'protocol' })
    expect(server.requests).toHaveLength(0)
  })

  describe('stream size bounds', () => {
    const delta = (size: number) =>
      `data: ${JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'x'.repeat(size) })}\n\n`
    const finish = `data: ${JSON.stringify(ev.message('ok'))}\n\ndata: ${JSON.stringify(ev.completed())}\n\n`

    it('rejects one event larger than the per-event bound on a single line', async () => {
      server.reply(rawSse([delta(MAX_EVENT_BYTES + 1024), finish]))
      expect(await failure(finalOf())).toMatchObject({
        code: 'protocol',
        message: expect.stringMatching(/oversized stream event/) as unknown,
      })
    })

    it('rejects an oversized line that never ends, without waiting for it', async () => {
      server.reply((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        // No newline and the stream stays open: only the line-buffer bound can stop it.
        res.write(`data: "${'x'.repeat(MAX_EVENT_BYTES + 1024)}`)
      })
      expect(await failure(finalOf(client({ timeoutMs: 10_000 })))).toMatchObject({
        code: 'protocol',
        message: expect.stringMatching(/oversized stream event/) as unknown,
      })
    }, 30_000)

    it('rejects one event split over many short data lines past the per-event bound', async () => {
      // Each line is short, so the line buffer never grows; only the event's total does.
      const lines = Math.ceil(MAX_EVENT_BYTES / 1024) + 16
      server.reply(
        rawSse([...splitEvent({ type: 'response.reasoning_text.delta' }, lines), finish]),
      )
      expect(await failure(finalOf())).toMatchObject({
        code: 'protocol',
        message: expect.stringMatching(/oversized stream event/) as unknown,
      })
    }, 30_000)

    it('accepts the same data split across many events under the bound', async () => {
      const event = splitEvent({ type: 'response.reasoning_text.delta' }, 1024)
      server.reply(rawSse([...Array.from({ length: 12 }, () => event).flat(), finish]))
      expect((await finalOf()).content).toMatchObject([{ type: 'text', text: 'ok' }])
    }, 30_000)

    it('rejects a stream larger than the total bound', async () => {
      const part = delta(1024 * 1024)
      const count = Math.ceil(MAX_STREAM_BYTES / part.length) + 2
      server.reply(rawSse([...Array.from({ length: count }, () => part), finish]))
      expect(await failure(finalOf())).toMatchObject({
        code: 'protocol',
        message: expect.stringMatching(/too large/) as unknown,
      })
    }, 60_000)
  })

  describe('responses that are not a plain event stream', () => {
    const write =
      (headers: Record<string, string>, body: string): Handler =>
      (_req, res) => {
        res.writeHead(200, headers)
        res.end(body)
      }
    const events = [ev.created(), ev.textDelta('Hi'), ev.message('Hi'), ev.completed()]
    const sseBody = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
    /** No token, and none of the provider's own words, anywhere in the error. */
    const clean = (error: Error) => {
      expect(leaks(error)).toBe(false)
      expect(error.message).not.toMatch(/PROVIDER|secret/i)
      expect(error.message.length).toBeLessThanOrEqual(300)
    }

    it.each([
      'text/event-stream; charset=utf-8',
      'Text/Event-Stream; Charset=UTF-8',
      'TEXT/EVENT-STREAM',
      ' text/event-stream ;charset="utf-8"',
    ])('streams with Content-Type %j', async (type) => {
      server.reply(write({ 'Content-Type': type }, sseBody))
      const deltas: string[] = []
      const stream = client().messages.stream(params, { signal: new AbortController().signal })
      stream.on('text', (d) => deltas.push(d))
      expect((await stream.finalMessage()).content).toMatchObject([{ type: 'text', text: 'Hi' }])
      expect(deltas).toEqual(['Hi'])
    })

    it('streams with no Content-Type when the body starts like SSE', async () => {
      for (const body of [sseBody, `: keep-alive\n\n${sseBody}`, `\uFEFF${sseBody}`]) {
        server.reply(write({}, body))
        expect((await finalOf()).content).toMatchObject([{ type: 'text', text: 'Hi' }])
      }
      // Split across writes: the first bytes are peeked, then the rest still streams.
      server.reply((_req, res) => {
        res.writeHead(200)
        for (const part of [sseBody.slice(0, 3), sseBody.slice(3, 40), sseBody.slice(40)])
          res.write(part)
        res.end()
      })
      expect((await finalOf()).content).toMatchObject([{ type: 'text', text: 'Hi' }])
    })

    it('accepts a complete non-streamed Responses object on the same terms', async () => {
      const response = {
        id: 'resp_9',
        object: 'response',
        status: 'completed',
        error: null,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Whole', annotations: [] }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 1 },
      }
      server.reply(json(200, response))
      const deltas: string[] = []
      const stream = client().messages.stream(params, { signal: new AbortController().signal })
      stream.on('text', (d) => deltas.push(d))
      expect(await stream.finalMessage()).toMatchObject({
        id: 'resp_9',
        content: [{ type: 'text', text: 'Whole' }],
        stop_reason: 'end_turn',
      })
      expect(deltas).toEqual(['Whole'])
      server.reply(
        json(200, {
          ...response,
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      )
      expect((await finalOf()).stop_reason).toBe('max_tokens')
      server.reply(
        json(200, {
          ...response,
          status: 'failed',
          error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'PROVIDER' },
        }),
      )
      expect((await failure(finalOf())).code).toBe('usage_limit')
      // Only a finished response counts.
      server.reply(json(200, { ...response, status: 'in_progress' }, { 'x-request-id': 'req_9' }))
      const error = await failure(finalOf())
      expect(error).toMatchObject({ code: 'protocol', status: 200 })
      expect(error.message).toBe(
        'ChatGPT did not stream its response. Try again, and report this problem if it continues. Details: HTTP 200, application/json, body response in_progress, request req_9.',
      )
    })

    it.each([
      [
        { 'Content-Type': 'application/json' },
        '{"detail":"secret words"}',
        'application/json, body detail',
      ],
      [
        { 'Content-Type': 'application/json' },
        '{"output":[]}',
        'application/json, body other JSON',
      ],
      [
        { 'Content-Type': 'text/html; charset=utf-8' },
        '<html>secret words</html>',
        'text/html, body not JSON',
      ],
      [{}, '{"detail":"secret words"}', 'no content type, body detail'],
      [{}, 'secret words', 'no content type, body not JSON'],
      [{ 'Content-Type': 'application/json' }, '', 'application/json, body empty'],
      [{ 'Content-Type': TOKEN }, '{}', 'other content type, body other JSON'],
      [{ 'Content-Type': `text/${TOKEN}` }, '{}', 'other content type, body other JSON'],
    ])('reports %j %j as a protocol error with diagnostics only', async (headers, body, facts) => {
      server.reply(write(headers, body))
      const error = await failure(finalOf())
      expect(error).toMatchObject({ code: 'protocol', status: 200 })
      expect(error.message).toContain(`did not stream its response`)
      expect(error.message).toContain(`Details: HTTP 200, ${facts}.`)
      clean(error)
    })

    it.each([
      [
        400,
        { code: 'invalid_value', param: 'model' },
        'invalid_request',
        'code invalid_value, param model',
      ],
      [
        400,
        { type: 'invalid_request_error', param: 'input[0].content' },
        'invalid_request',
        'type invalid_request_error, param input[0].content',
      ],
      [401, { code: 'invalid_api_key' }, 'auth_expired', 'code invalid_api_key'],
      [
        403,
        { code: 'unsupported_country_region_territory' },
        'permission',
        'code unsupported_country_region_territory',
      ],
      [
        429,
        { code: 'rate_limit_exceeded', type: 'requests' },
        'rate_limit',
        'code rate_limit_exceeded, type requests',
      ],
      [500, { code: 'server_error' }, 'api', 'code server_error'],
    ] as const)(
      'shows HTTP %i %j as %s with its code and param',
      async (status, error, code, facts) => {
        server.reply(
          json(
            status,
            { error: { ...error, message: `PROVIDER says ${TOKEN}` } },
            { 'x-request-id': 'req_1' },
          ),
        )
        const mapped = await failure(finalOf())
        expect(mapped).toMatchObject({ code, status })
        expect(mapped.message).toContain(
          `Details: HTTP ${String(status)}, application/json, ${facts}, request req_1.`,
        )
        clean(mapped)
      },
    )

    it('shows the 2xx status of an error body, and never a code or type that is prose', async () => {
      server.reply(json(200, { error: { code: 'brand_new_code', message: 'PROVIDER' } }))
      const mapped = await failure(finalOf())
      expect(mapped.code).toBe('api')
      expect(mapped.message).toContain('Details: HTTP 200, application/json, code brand_new_code.')
      server.reply(
        json(400, {
          error: { code: 'secret words here', type: `x ${TOKEN}`, param: 'PROVIDER text' },
        }),
      )
      const prose = await failure(finalOf())
      expect(prose.message).toContain('Details: HTTP 400, application/json.')
      clean(prose)
      // A documented code keeps its own message, with the details after it.
      server.reply(
        json(
          403,
          { error: { code: 'subscription_sharing_user_not_eligible' } },
          { 'x-request-id': 'req_7' },
        ),
      )
      expect((await failure(finalOf())).message).toMatch(
        /^Needs ChatGPT Plus or Pro\..* Details: HTTP 403, application\/json, code subscription_sharing_user_not_eligible, request req_7\.$/,
      )
      // Admission failures say they were `{detail}`, without its text.
      server.reply(json(401, { detail: `secret words ${TOKEN}` }))
      const admission = await failure(finalOf())
      expect(admission.message).toContain('Details: HTTP 401, application/json, body detail.')
      clean(admission)
    })

    it('refuses a body past the size cap instead of parsing a cut copy of it', async () => {
      // Valid JSON within the cap, then bytes past it in the same write: never parsed.
      const valid = JSON.stringify({ id: 'resp_big', object: 'response', status: 'completed' })
      server.reply(
        write(
          { 'Content-Type': 'application/json' },
          `${valid}${' '.repeat(MAX_EVENT_BYTES - valid.length)}x`,
        ),
      )
      const error = await failure(finalOf())
      expect(error.code).toBe('protocol')
      expect(error.message).toContain('Details: HTTP 200, application/json, body too large.')
    })

    it('runs only offered tool calls from a complete non-streamed response', async () => {
      const callResponse = (name: string) => ({
        id: 'resp_c',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            status: 'completed',
            call_id: 'call_1',
            namespace: TOOL_NAMESPACE,
            name,
            arguments: '{"path":"a.txt"}',
          },
        ],
      })
      server.reply(json(200, callResponse('read')))
      expect(await finalOf(client(), withTools)).toMatchObject({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'read', input: { path: 'a.txt' } }],
      })
      server.reply(json(200, callResponse('delete_everything')))
      expect(await failure(finalOf(client(), withTools))).toMatchObject({
        code: 'protocol',
        message: expect.stringMatching(/did not offer/) as unknown,
      })
    })
  })

  describe('diagnostics never show the credential', () => {
    // Token-shaped values that each field's pattern alone would accept, so only the check
    // against the credential sent with the request keeps them out.
    const SHAPED = 'opaque_token_value_abcdef'
    const REQ_TOKEN = 'req_0123456789abcdefXYZ'
    const OTHERS = [
      TOKEN,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'sk-proj-AbCdEf0123456789GhIjKl',
      'a3f9c2e1d4b5a6f7e8d9c0b1a2f3e4d5',
    ]
    const tokenClient = (token: string) => client({ getAccessToken: () => Promise.resolve(token) })
    const shows = (error: Error, value: string) =>
      `${error.message} ${JSON.stringify(error)}`.toLowerCase().includes(value.toLowerCase())

    it.each([
      [
        'x-request-id',
        REQ_TOKEN,
        (v: string) => json(400, { error: { code: 'x_y' } }, { 'x-request-id': v }),
      ],
      [
        'openai-request-id',
        REQ_TOKEN,
        (v: string) => json(400, { error: {} }, { 'openai-request-id': v }),
      ],
      ['error.code', SHAPED, (v: string) => json(400, { error: { code: v } })],
      [
        'error.code (a run of it)',
        SHAPED,
        (v: string) => json(400, { error: { code: `zz_${v.slice(0, 12)}` } }),
      ],
      ['error.type', SHAPED, (v: string) => json(400, { error: { type: v } })],
      ['error.param', SHAPED, (v: string) => json(400, { error: { param: v } })],
      [
        'error.param (tool field)',
        SHAPED,
        (v: string) => json(400, { error: { param: `tools[0].${v}` } }),
      ],
      ['a 2xx error body', SHAPED, (v: string) => json(200, { error: { code: v, param: v } })],
      [
        'a non-stream response status',
        'in_progress_token_value',
        (v: string) => json(200, { object: 'response', status: v }),
      ],
      [
        'an in-stream failure',
        SHAPED,
        (v: string) =>
          responsesSse([{ type: 'response.failed', response: { error: { code: v, param: v } } }]),
      ],
      [
        'an in-stream error event',
        SHAPED,
        (v: string) => responsesSse([{ type: 'error', code: v, param: v }]),
      ],
    ] as const)('drops the token from %s', async (_field, token, reply) => {
      server.reply(reply(token))
      const error = (await failure(finalOf(tokenClient(token)))) as ResponsesError
      expect(shows(error, token)).toBe(false)
      expect(shows(error, token.slice(0, 12))).toBe(false)
      expect(error.requestId).toBeUndefined()
      if (error.param) expect(shows(error, error.param)).toBe(true)
      expect(server.requests.at(-1)?.headers.authorization).toBe(`Bearer ${token}`)
    })

    it.each(OTHERS)('never shows the token-like value %s in any field', async (value) => {
      server.reply(
        json(
          400,
          { error: { code: value, type: value, param: value, message: value } },
          { 'x-request-id': value, 'content-type': value },
        ),
      )
      const error = await failure(finalOf())
      expect(shows(error, value)).toBe(false)
      expect(error.message).toContain('Details: HTTP 400, other content type.')
    })

    it.each([
      ['response.failed', { type: 'response.failed', response: { id: 'r', status: 'failed' } }],
      ['response.failed', ev.failed('', `PROVIDER ${TOKEN}`)],
      ['error', { type: 'error', message: `PROVIDER ${TOKEN}` }],
      ['error', { type: 'error', code: SHAPED, param: SHAPED, message: 'PROVIDER' }],
    ] as const)(
      'ends an in-stream %s with no safe code, type or param with fixed details',
      async (name, event) => {
        server.reply((_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'x-request-id': 'req_s1',
          })
          res.write(`data: ${JSON.stringify(ev.textDelta('Hi'))}\n\n`)
          res.end(`data: ${JSON.stringify(event)}\n\n`)
        })
        const error = await failure(finalOf(tokenClient(SHAPED)))
        expect(error.message).toMatch(
          new RegExp(
            ` Details: HTTP 200, text/event-stream, stream event ${name.replace('.', '\\.')}, request req_s1\\.$`,
          ),
        )
        expect(shows(error, TOKEN)).toBe(false)
        expect(shows(error, SHAPED)).toBe(false)
        expect(error.message).not.toMatch(/PROVIDER/)
      },
    )

    it('still shows ordinary values when a different token was sent', async () => {
      server.reply(
        json(
          400,
          { error: { code: 'invalid_value', type: 'invalid_request_error', param: 'model' } },
          {
            'x-request-id': 'req_abc123',
          },
        ),
      )
      const error = await failure(finalOf(tokenClient(SHAPED)))
      expect(error.message).toContain(
        'Details: HTTP 400, application/json, code invalid_value, type invalid_request_error, param model, request req_abc123.',
      )
    })

    it('fits the details into the message cap, keeping status and request id', async () => {
      server.reply(
        json(
          503,
          {
            error: {
              code: `a${'_b'.repeat(7)}`.padEnd(40, 'c'),
              type: 'invalid_request_error',
              param: 'tools[0].tools[12].parameters.properties.path.description',
            },
          },
          { 'x-request-id': `req_${'A'.repeat(64)}`, 'content-type': 'application/problem+json' },
        ),
      )
      const error = await failure(finalOf())
      expect(error.message.length).toBeLessThanOrEqual(300)
      expect(error.message).toMatch(/Details: HTTP 503, .*request req_A{64}\.$/)
    })
  })
})
