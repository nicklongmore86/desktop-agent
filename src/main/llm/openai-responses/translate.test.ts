import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import { assertAllowedBody, OMITTED_BODY_KEYS, toResponsesRequest } from './translate'

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
        store: false,
        stream: true,
      })
    }).not.toThrow()
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
      ['function_call', 'a'],
      ['function_call', 'b'],
      ['function_call_output', 'b'],
      ['function_call_output', 'a'],
      ['function_call', 'c'],
      ['function_call_output', 'c'],
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
