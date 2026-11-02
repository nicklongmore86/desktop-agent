// The optional ChatGPT plan request features (parallel tool calls, reasoning continuity),
// against a fake Responses server.
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
  type FakeServer,
  type Handler,
} from '../openai-compat/test-support'
import {
  createChatGPTResponsesClient,
  resetRefusedFeatures,
  type ChatGPTResponsesClientOptions,
} from './client'
import {
  ALLOWED_BODY_KEYS,
  OMITTED_BODY_KEYS,
  PLAN_FEATURES_ENV,
  TOOL_NAMESPACE,
  type PlanFeatures,
} from './translate'

let server: FakeServer
let sb: Sandbox
let seen: string[]
beforeEach(async () => {
  server = await fakeServer()
  sb = await makeSandbox()
  seen = []
  resetRefusedFeatures()
})
afterEach(async () => {
  await server.close()
  await sb.cleanup()
  resetRefusedFeatures()
  vi.unstubAllEnvs()
})

const TOKEN = 'eyJhbGciOi.SECRET-access-token-0123456789.sig'
const ENCRYPTED = 'gAAAAB-ENCRYPTED-REASONING-PAYLOAD-42'
const ON: PlanFeatures = { parallelToolCalls: true, reasoning: true }
const client = (overrides: Partial<ChatGPTResponsesClientOptions> = {}) =>
  createChatGPTResponsesClient({
    model: 'gpt-6.1-sol',
    getAccessToken: () => Promise.resolve(TOKEN),
    fetch: redirectFetch(server.origin, seen),
    ...overrides,
  })
const withTools: MessageCreateParamsNonStreaming = {
  model: 'ignored',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hi' }],
  tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
}
const finalOf = (c: ReturnType<typeof client>, p = withTools) =>
  c.messages.stream(p, { signal: new AbortController().signal }).finalMessage()
const bodyOf = (i: number) =>
  server.requests[i]?.body as Record<string, unknown> & {
    input: Record<string, unknown>[]
  }
const reasoningEvent = (encrypted = ENCRYPTED, id = 'rs_1') => ({
  type: 'response.output_item.done',
  output_index: 0,
  item: {
    type: 'reasoning',
    id,
    summary: [{ type: 'summary_text', text: 'Thinking about the notes' }],
    encrypted_content: encrypted,
  },
})
const call = (call_id: string, name: string, args: string) =>
  ev.call({ call_id, name, arguments: args, namespace: TOOL_NAMESPACE })
const leaks = (value: unknown, needle: string): boolean => {
  const e = value as Error
  return `${e.message} ${e.stack ?? ''} ${JSON.stringify(e)} ${String(e)}`.includes(needle)
}
async function failure(promise: Promise<unknown>): Promise<OpenAICompatError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(OpenAICompatError)
  return error as OpenAICompatError
}

async function agentRun(features: Partial<PlanFeatures> | undefined, prompt = 'Read both') {
  const events: AgentEvent[] = []
  const agent = createAgent({
    client: client(features ? { features } : {}),
    tools: Object.values(toolHarness(sb).tools),
    errorEvent: openAICompatErrorEvent,
  })
  const result = await agent.run([{ role: 'user', content: prompt }], {
    signal: new AbortController().signal,
    requestApproval: () => Promise.resolve(false),
    onEvent: (event) => events.push(event),
  })
  return { result, events }
}

/** Two read_file calls in one response, after a reasoning item; then a final answer. */
async function twoReads(): Promise<Handler[]> {
  await put(path.join(sb.root, 'a.txt'), 'alpha\n')
  await put(path.join(sb.root, 'b.txt'), 'beta\n')
  const args = (name: string) => JSON.stringify({ path: path.join(sb.root, name) })
  return [
    responsesSse([
      reasoningEvent(),
      call('call_a', 'read_file', args('a.txt')),
      call('call_b', 'read_file', args('b.txt')),
      ev.completed(),
    ]),
    responsesSse([
      reasoningEvent('gAAAAB-SECOND', 'rs_2'),
      ev.message('alpha, beta'),
      ev.completed(),
    ]),
  ]
}

describe('optional ChatGPT plan request features', () => {
  it('are off by default: no new fields, no reasoning sent back', async () => {
    server.reply(...(await twoReads()))
    const { result } = await agentRun(undefined)
    expect(result.stopReason).toBe('end_turn')
    for (const i of [0, 1]) {
      expect(bodyOf(i)).not.toHaveProperty('parallel_tool_calls')
      expect(bodyOf(i)).not.toHaveProperty('include')
      expect(JSON.stringify(bodyOf(i))).not.toContain(ENCRYPTED)
    }
  })

  it('turn on through the environment flag only', async () => {
    vi.stubEnv(PLAN_FEATURES_ENV, 'parallel_tool_calls')
    server.reply(responsesSse([ev.message('ok'), ev.completed()]))
    await finalOf(client())
    expect(bodyOf(0)).toMatchObject({ parallel_tool_calls: true })
    expect(bodyOf(0)).not.toHaveProperty('include')
  })

  it('send parallel_tool_calls and include, and run parallel calls in one turn', async () => {
    server.reply(...(await twoReads()))
    const { result, events } = await agentRun(ON)
    expect(result.stopReason).toBe('end_turn')
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.id)).toEqual([
      'call_a',
      'call_b',
    ])
    for (const i of [0, 1]) {
      expect(bodyOf(i)).toMatchObject({
        parallel_tool_calls: true,
        include: ['reasoning.encrypted_content'],
        store: false,
        stream: true,
      })
      for (const key of Object.keys(bodyOf(i))) expect(ALLOWED_BODY_KEYS).toContain(key)
      for (const key of OMITTED_BODY_KEYS) expect(bodyOf(i)).not.toHaveProperty(key)
    }
  })

  it('send reasoning back within the run, in memory only', async () => {
    server.reply(...(await twoReads()))
    const { result, events } = await agentRun(ON)
    // The second request carries the first response's reasoning before its calls.
    expect(bodyOf(1).input.map((item) => item.type)).toEqual([
      'message',
      'reasoning',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
    ])
    expect(bodyOf(1).input[1]).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Thinking about the notes' }],
      encrypted_content: ENCRYPTED,
    })
    // Nothing of it reaches the transcript (what is saved) or the events (what is shown).
    const saved = JSON.stringify(result.conversation)
    expect(saved).not.toContain(ENCRYPTED)
    expect(saved).not.toContain('gAAAAB-SECOND')
    expect(saved).not.toContain('Thinking about the notes')
    expect(saved).not.toMatch(/"type":"(reasoning|thinking)"/)
    expect(JSON.stringify(events)).not.toContain(ENCRYPTED)
    expect(JSON.stringify(events)).not.toContain('Thinking about the notes')

    // A new run (a new client, as for every message or after a provider switch) has no
    // memory: the same history goes without reasoning.
    server.requests.length = 0
    server.reply(responsesSse([ev.message('ok'), ev.completed()]))
    await finalOf(client({ features: ON }), {
      ...withTools,
      messages: [...result.conversation, { role: 'user', content: 'And again' }],
    })
    expect(JSON.stringify(bodyOf(0))).not.toContain(ENCRYPTED)
    expect(bodyOf(0).input.some((item) => item.type === 'reasoning')).toBe(false)
  })

  it('never keep reasoning in an error, or reasoning without encrypted content', async () => {
    server.reply(
      responsesSse([
        { ...reasoningEvent(), item: { type: 'reasoning', id: 'rs_x', summary: [] } },
        call('call_a', 'f', '{}'),
        ev.completed(),
      ]),
      responsesSse([reasoningEvent(), ev.failed('server_error', `provider ${ENCRYPTED}`)]),
    )
    const shared = client({ features: ON })
    await finalOf(shared)
    const history: MessageCreateParamsNonStreaming['messages'] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'r' }] },
    ]
    const error = await failure(finalOf(shared, { ...withTools, messages: history }))
    expect(bodyOf(1).input.some((item) => item.type === 'reasoning')).toBe(false)
    expect(leaks(error, ENCRYPTED)).toBe(false)
    expect(leaks(error, TOKEN)).toBe(false)
  })

  describe('when OpenAI refuses a field', () => {
    const rejecting = (param: string, status = 400): Handler =>
      json(status, {
        error: { code: 'unknown_parameter', param, message: `Unknown ${param} ${TOKEN}` },
      })

    it('retries once without parallel_tool_calls and remembers it for the session', async () => {
      server.reply(
        rejecting('parallel_tool_calls'),
        responsesSse([ev.message('ok'), ev.completed()]),
      )
      const message = await finalOf(client({ features: ON }))
      expect(message.content).toMatchObject([{ type: 'text', text: 'ok' }])
      expect(server.requests).toHaveLength(2)
      expect(bodyOf(0)).toMatchObject({ parallel_tool_calls: true })
      expect(bodyOf(1)).not.toHaveProperty('parallel_tool_calls')
      // Only the refused field goes.
      expect(bodyOf(1)).toMatchObject({ include: ['reasoning.encrypted_content'] })

      // A later client (the next message) never sends it, and its errors say so.
      server.requests.length = 0
      server.reply(json(500, { error: { code: 'server_error', message: `oops ${TOKEN}` } }))
      const error = await failure(finalOf(client({ features: ON })))
      expect(server.requests).toHaveLength(1)
      expect(bodyOf(0)).not.toHaveProperty('parallel_tool_calls')
      expect(error.message).toMatch(/ Details: HTTP 500, .*without parallel_tool_calls\.$/)
      expect(leaks(error, TOKEN)).toBe(false)
      for (const r of server.requests) expect(JSON.stringify(r.body)).not.toContain(TOKEN)
    })

    it('retries once without include, still sending encrypted reasoning it gets', async () => {
      server.reply(
        rejecting('include'),
        responsesSse([reasoningEvent(), call('call_a', 'f', '{}'), ev.completed()]),
        responsesSse([ev.message('ok'), ev.completed()]),
      )
      const shared = client({ features: ON })
      const first = await finalOf(shared)
      expect(server.requests).toHaveLength(2)
      expect(bodyOf(1)).not.toHaveProperty('include')
      expect(bodyOf(1)).toMatchObject({ parallel_tool_calls: true })
      await finalOf(shared, {
        ...withTools,
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'r' }] },
        ],
      })
      expect(bodyOf(2)).not.toHaveProperty('include')
      expect(bodyOf(2).input[1]).toMatchObject({ type: 'reasoning', encrypted_content: ENCRYPTED })
    })

    it('retries once without reasoning items when one is refused', async () => {
      server.reply(
        responsesSse([reasoningEvent(), call('call_a', 'f', '{}'), ev.completed()]),
        rejecting('input[1].encrypted_content'),
        responsesSse([ev.message('ok'), ev.completed()]),
      )
      const shared = client({ features: ON })
      const first = await finalOf(shared)
      const message = await finalOf(shared, {
        ...withTools,
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'r' }] },
        ],
      })
      expect(message.content).toMatchObject([{ type: 'text', text: 'ok' }])
      expect(server.requests).toHaveLength(3)
      expect(bodyOf(1).input[1]).toMatchObject({ type: 'reasoning' })
      expect(bodyOf(2).input.some((item) => item.type === 'reasoning')).toBe(false)
      expect(JSON.stringify(bodyOf(2))).not.toContain(ENCRYPTED)
    })

    it('never loops: a second refusal of the same request is the error', async () => {
      server.reply(rejecting('parallel_tool_calls'))
      const error = await failure(finalOf(client({ features: ON })))
      expect(server.requests).toHaveLength(2)
      expect(error.code).toBe('invalid_request')
      expect(error.message).toContain('without parallel_tool_calls')
      expect(leaks(error, TOKEN)).toBe(false)
    })

    it('never resends after text has streamed', async () => {
      server.reply(
        responsesSse([
          ev.textDelta('Hel'),
          {
            type: 'response.failed',
            response: { error: { code: 'unknown_parameter', param: 'parallel_tool_calls' } },
          },
        ]),
        responsesSse([ev.message('second send'), ev.completed()]),
      )
      const stream = client({ features: ON }).messages.stream(withTools, {
        signal: new AbortController().signal,
      })
      const deltas: string[] = []
      stream.on('text', (text) => deltas.push(text))
      await failure(stream.finalMessage())
      expect(server.requests).toHaveLength(1)
      expect(deltas).toEqual(['Hel'])
    })

    it.each([
      ['a field it did not send', 'temperature', 400],
      ['a server error naming the field', 'parallel_tool_calls', 500],
      ['an input item that is not reasoning', 'input[0].content', 400],
    ])('does not retry for %s', async (_label, param, status) => {
      server.reply(rejecting(param, status))
      await failure(finalOf(client({ features: ON })))
      expect(server.requests).toHaveLength(1)
    })

    it('does not touch requests with the features off', async () => {
      server.reply(rejecting('parallel_tool_calls'))
      await failure(finalOf(client()))
      expect(server.requests).toHaveLength(1)
    })
  })
})
