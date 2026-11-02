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
  MAX_KEPT_REASONING,
  ReasoningMemory,
  resetRefusedFeatures,
  type ChatGPTResponsesClientOptions,
} from './client'
import { MAX_REASONING_BYTES, ResponsesAccumulator } from './stream'
import {
  ALLOWED_BODY_KEYS,
  OMITTED_BODY_KEYS,
  PLAN_FEATURES_ENV,
  TOOL_NAMESPACE,
  type PlanFeatures,
  type ResponsesReasoningItem,
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
    // Both calls from the one response ran; the agent runs them concurrently, so their
    // results may finish in either order.
    expect(events.filter((e) => e.type === 'tool_use').map((e) => e.id)).toEqual([
      'call_a',
      'call_b',
    ])
    expect(
      events
        .filter((e) => e.type === 'tool_result')
        .map((e) => e.id)
        .sort(),
    ).toEqual(['call_a', 'call_b'])
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

describe('reasoning size limits count UTF-8 bytes as sent', () => {
  const MiB = 1024 * 1024
  /** '€' is one UTF-16 unit but three UTF-8 bytes. */
  const item = (id: string, ascii: number, euros: number): ResponsesReasoningItem => ({
    type: 'reasoning',
    id,
    summary: [{ type: 'summary_text', text: '€'.repeat(euros) }],
    encrypted_content: 'e'.repeat(ascii),
  })
  const bytes = (items: readonly ResponsesReasoningItem[]) =>
    items.reduce((n, i) => n + Buffer.byteLength(JSON.stringify(i), 'utf8'), 0)
  const chars = (i: ResponsesReasoningItem) =>
    i.encrypted_content.length + i.summary.reduce((n, p) => n + p.text.length, 0)
  const accumulate = (items: ResponsesReasoningItem[]) => {
    const acc = new ResponsesAccumulator('m', new Set())
    items.forEach((i, n) =>
      acc.add({ type: 'response.output_item.done', output_index: n, item: i }),
    )
    return acc.reasoningItems()
  }

  it('drops a response item whose bytes pass 4 MiB though its characters do not', () => {
    const big = item('rs_big', 3 * MiB, 400_000)
    expect(chars(big)).toBeLessThan(MAX_REASONING_BYTES)
    expect(bytes([big])).toBeGreaterThan(MAX_REASONING_BYTES)
    const small = item('rs_small', 1000, 1000)
    const kept = accumulate([big, small])
    // Dropped whole, never cut; a later item that fits is still kept, unchanged.
    expect(kept).toEqual([small])
    expect(bytes(kept)).toBeLessThanOrEqual(MAX_REASONING_BYTES)
  })

  it('stops keeping response items once their bytes would pass 4 MiB', () => {
    // Each fits alone; the characters of all three fit too, but their bytes do not.
    const parts = ['rs_1', 'rs_2', 'rs_3'].map((id) => item(id, MiB, 120_000))
    expect(parts.reduce((n, i) => n + chars(i), 0)).toBeLessThan(MAX_REASONING_BYTES)
    expect(bytes(parts)).toBeGreaterThan(MAX_REASONING_BYTES)
    const kept = accumulate(parts)
    expect(kept.map((i) => i.id)).toEqual(['rs_1', 'rs_2'])
    expect(kept[1]).toEqual(parts[1])
    expect(bytes(kept)).toBeLessThanOrEqual(MAX_REASONING_BYTES)
  })

  it("gives back a replaced entry's bytes, so nothing newer is evicted", () => {
    const memory = new ReasoningMemory()
    const a = [item('rs_a', 20 * MiB, 0)]
    const small = [item('rs_a2', 1024, 10)]
    const b = [item('rs_b', 20 * MiB, 0)]
    const c = [item('rs_c', 10 * MiB, 0)]
    memory.set(['call_a'], a)
    memory.set(['call_a'], small)
    expect(memory.bytes).toBe(bytes(small))
    memory.set(['call_b'], b)
    memory.set(['call_c'], c)
    // About 30 MiB in all: within the limit, so all three stay.
    expect(memory.get(['call_a'])).toEqual(small)
    expect(memory.get(['call_b'])).toEqual(b)
    expect(memory.get(['call_c'])).toEqual(c)
    expect(memory.bytes).toBe(bytes([...small, ...b, ...c]))
  })

  it('makes a replaced key the newest for eviction', () => {
    const memory = new ReasoningMemory()
    const ten = (id: string) => [item(id, 10 * MiB, 0)]
    memory.set(['call_a'], ten('rs_a'))
    memory.set(['call_b'], ten('rs_b'))
    const again = ten('rs_a2')
    memory.set(['call_a'], again)
    const c = [item('rs_c', 15 * MiB, 0)]
    memory.set(['call_c'], c)
    // Over 32 MiB: the oldest (b, since a was replaced after it) goes, and only it.
    expect(memory.get(['call_b'])).toBeUndefined()
    expect(memory.get(['call_a'])).toEqual(again)
    expect(memory.get(['call_c'])).toEqual(c)
    expect(memory.bytes).toBe(bytes([...again, ...c]))
  })

  it('keeps a run within 32 MiB of bytes, dropping the oldest', () => {
    const memory = new ReasoningMemory()
    const entries = Array.from({ length: 9 }, (_, n) => [
      item(`rs_${String(n)}`, 2.5 * MiB, 450_000),
    ])
    // Each passes the per-response limit; their characters fit the run, their bytes do not.
    for (const entry of entries) expect(bytes(entry)).toBeLessThanOrEqual(MAX_REASONING_BYTES)
    expect(entries.flat().reduce((n, i) => n + chars(i), 0)).toBeLessThan(MAX_KEPT_REASONING)
    expect(entries.reduce((n, e) => n + bytes(e), 0)).toBeGreaterThan(MAX_KEPT_REASONING)
    entries.forEach((entry, n) => {
      memory.set([`call_${String(n)}`], entry)
    })
    expect(memory.get(['call_0'])).toBeUndefined()
    expect(memory.get(['call_8'])).toEqual(entries[8])
    const kept = entries.flatMap((entry, n) => (memory.get([`call_${String(n)}`]) ? entry : []))
    expect(memory.bytes).toBe(bytes(kept))
    expect(memory.bytes).toBeLessThanOrEqual(MAX_KEPT_REASONING)
  })
})
