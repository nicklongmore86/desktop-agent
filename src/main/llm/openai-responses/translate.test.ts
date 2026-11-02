import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_BODY_KEYS,
  assertAllowedBody,
  OMITTED_BODY_KEYS,
  planFeaturesFrom,
  toResponsesRequest,
  type ResponsesReasoningItem,
} from './translate'

describe('assertAllowedBody', () => {
  it.each(OMITTED_BODY_KEYS)('refuses a body with %s', (key) => {
    expect(() => {
      assertAllowedBody({ model: 'm', input: [], store: false, stream: true, [key]: 1 })
    }).toThrow(expect.objectContaining({ code: 'invalid_request' }))
  })

  it('accepts the fields this client sends', () => {
    expect(() => {
      assertAllowedBody({
        model: 'm',
        instructions: 'i',
        input: [],
        tools: [],
        parallel_tool_calls: true,
        include: ['reasoning.encrypted_content'],
        store: false,
        stream: true,
      })
    }).not.toThrow()
  })

  it('allows only the six base fields plus parallel_tool_calls and include', () => {
    expect([...ALLOWED_BODY_KEYS].sort()).toEqual([
      'include',
      'input',
      'instructions',
      'model',
      'parallel_tool_calls',
      'store',
      'stream',
      'tools',
    ])
    expect(ALLOWED_BODY_KEYS.filter((key) => OMITTED_BODY_KEYS.includes(key))).toEqual([])
    for (const key of ['reasoning', 'previous_response_id', 'tool_choice', 'service_tier'])
      expect(() => {
        assertAllowedBody({ model: 'm', input: [], store: false, stream: true, [key]: 1 })
      }).toThrow(expect.objectContaining({ code: 'invalid_request' }))
  })
})

describe('planFeaturesFrom', () => {
  it.each([
    [undefined, false, false],
    ['', false, false],
    ['yes', false, false],
    ['parallel_tool_calls', true, false],
    [' Reasoning ', false, true],
    ['parallel_tool_calls,reasoning', true, true],
    ['all', true, true],
  ])('%j', (value, parallelToolCalls, reasoning) => {
    expect(planFeaturesFrom(value)).toEqual({ parallelToolCalls, reasoning })
  })
})

const ask: MessageParam = { role: 'user', content: 'Go' }
const calls = (...ids: string[]): MessageParam => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_use' as const, id, name: 'f', input: {} })),
})
const results = (...ids: string[]): MessageParam => ({
  role: 'user',
  content: ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'r' })),
})
const request = (messages: MessageParam[]) =>
  toResponsesRequest({ model: 'm', max_tokens: 1, messages })

describe('toResponsesRequest tool pairing', () => {
  it('sends each result after the call it answers', () => {
    const { input } = request([ask, calls('a', 'b'), results('b', 'a'), calls('c'), results('c')])
    expect(input.map((item) => [item.type, 'call_id' in item ? item.call_id : ''])).toEqual([
      ['message', ''],
      ['function_call', 'call00000'],
      ['function_call', 'call00001'],
      ['function_call_output', 'call00001'],
      ['function_call_output', 'call00000'],
      ['function_call', 'call00002'],
      ['function_call_output', 'call00002'],
    ])
  })

  it.each([
    ['with no call at all', [ask, results('a')]],
    ['for an id the previous message did not call', [ask, calls('a'), results('b')]],
    ['for a call answered earlier', [ask, calls('a'), results('a'), results('a')]],
    ['answering the same call twice', [ask, calls('a'), results('a', 'a')]],
    [
      'for a call two messages back',
      [ask, calls('a'), { role: 'user', content: 'wait' }, results('a')],
    ],
  ] as [string, MessageParam[]][])('refuses a tool result %s', (_label, messages) => {
    expect(() => request(messages)).toThrow(
      expect.objectContaining({
        code: 'protocol',
        message: expect.stringMatching(/tool result without its tool call/) as unknown,
      }),
    )
  })
})

describe('toResponsesRequest features', () => {
  const item = (id: string): ResponsesReasoningItem => ({
    type: 'reasoning',
    id,
    summary: [],
    encrypted_content: `enc-${id}`,
  })
  const kept: Record<string, ResponsesReasoningItem[]> = { a: [item('rs_a')], c: [item('rs_c')] }
  const reasoningFor = (ids: readonly string[]) => kept[ids.join(',')]
  const withTool = (messages: MessageParam[], features = {}) =>
    toResponsesRequest(
      {
        model: 'm',
        max_tokens: 1,
        messages,
        tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
      },
      'output',
      features,
    )

  it('sends no optional field unless asked', () => {
    const body = withTool([ask])
    expect(body).not.toHaveProperty('parallel_tool_calls')
    expect(body).not.toHaveProperty('include')
  })

  it('sends parallel_tool_calls only with tools', () => {
    expect(withTool([ask], { parallelToolCalls: true })).toMatchObject({
      parallel_tool_calls: true,
    })
    expect(request([ask])).not.toHaveProperty('parallel_tool_calls')
    expect(
      toResponsesRequest({ model: 'm', max_tokens: 1, messages: [ask] }, 'output', {
        parallelToolCalls: true,
        include: true,
      }),
    ).toMatchObject({ include: ['reasoning.encrypted_content'] })
  })

  it('sends reasoning back only since the last typed user message', () => {
    const { input } = withTool(
      [ask, calls('a'), results('a'), { role: 'user', content: 'next' }, calls('c'), results('c')],
      { reasoningFor },
    )
    expect(input.filter((i) => i.type === 'reasoning')).toEqual([item('rs_c')])
    // It comes right before the calls it led to.
    const at = input.findIndex((i) => i.type === 'reasoning')
    expect(input[at + 1]).toMatchObject({ type: 'function_call', call_id: 'call00001' })
  })

  it('never sends reasoning without reasoningFor', () => {
    const { input } = withTool([ask, calls('a'), results('a')])
    expect(input.some((i) => i.type === 'reasoning')).toBe(false)
  })
})
