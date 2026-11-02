import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import { toResponsesRequest } from '../openai-responses/translate'
import { ResponsesAccumulator } from '../openai-responses/stream'
import { ChunkAccumulator } from './stream'
import { savedToolIds, TOOL_ID_ALIAS, ToolIdAliases, UNMATCHED_RESULT_MESSAGE } from './tool-ids'
import { toChatRequest, type ChatMessage } from './translate'

// Saved ids from every connector: Anthropic, Gemini, a bridge UUID, a 64-character id kept
// by transcriptToolId, and a 9-character Mistral id.
const ANTHROPIC = 'toolu_01A09q90qw90lq917835lq9'
const GEMINI = 'toolu_gemini_0123456789abcdef01234567'
const UUID = '0b7d4c1e-3f2a-4a8b-9c6d-5e4f3a2b1c0d'
const LONG = 'functions_read_file_0_' + 'x'.repeat(42)
const MISTRAL = 'aB3dE5fG7'
const SAVED = [ANTHROPIC, GEMINI, UUID, LONG, MISTRAL]

const ask: MessageParam = { role: 'user', content: 'go' }
const calls = (...ids: string[]): MessageParam => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_use', id, name: 'read_file', input: { path: id } })),
})
const results = (...ids: string[]): MessageParam => ({
  role: 'user',
  content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: `out ${id}` })),
})
const history: MessageParam[] = [
  ask,
  calls(ANTHROPIC, GEMINI),
  results(GEMINI, ANTHROPIC),
  calls(UUID),
  results(UUID),
  calls(LONG, MISTRAL),
  results(LONG, MISTRAL),
]
const params = (messages: MessageParam[]) => ({ model: 'm', max_tokens: 1, messages })

type ToolMessage = Extract<ChatMessage, { role: 'tool' }>

describe('ToolIdAliases', () => {
  it('gives each saved id one short, provider-safe alias, numbered by first use', () => {
    const aliases = new ToolIdAliases()
    const sent = SAVED.map((id) => aliases.alias(id))
    expect(sent).toEqual(['call00000', 'call00001', 'call00002', 'call00003', 'call00004'])
    expect(SAVED.map((id) => aliases.alias(id))).toEqual(sent)
    for (const alias of sent) {
      expect(alias).toMatch(TOOL_ID_ALIAS)
      expect(alias).toMatch(/^[A-Za-z0-9]{9}$/)
    }
    expect(sent.map((alias) => aliases.savedId(alias))).toEqual(SAVED)
    expect(aliases.savedId('call99999')).toBeUndefined()
  })
})

describe('openai-compat tool id aliasing', () => {
  it('never sends a saved id, and pairs every call with its own result', () => {
    const { messages } = toChatRequest(params(history), 'openrouter')
    const sentCalls = messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []) : []))
    const sentResults = messages.filter((m): m is ToolMessage => m.role === 'tool')
    expect(sentCalls.map((c) => c.id)).toEqual(SAVED.map((_, i) => `call0000${String(i)}`))
    // Each result is paired with the call whose arguments name the same saved id.
    for (const result of sentResults) {
      const call = sentCalls.find((c) => c.id === result.tool_call_id)
      expect(call).toBeDefined()
      const input = JSON.parse(call?.function.arguments ?? '{}') as { path: string }
      expect(result.content).toBe(`out ${input.path}`)
    }
    const sentIds = [...sentCalls.map((c) => c.id), ...sentResults.map((r) => r.tool_call_id)]
    expect(sentIds).toHaveLength(SAVED.length * 2)
    for (const id of sentIds) {
      expect(SAVED).not.toContain(id)
      expect(id.length).toBeLessThanOrEqual(40)
    }
  })

  it('gives the same history the same aliases on the next turn', () => {
    const first = toChatRequest(params(history.slice(0, 3)), 'openai').messages
    const second = toChatRequest(params(history), 'openai').messages
    expect(second.slice(0, first.length)).toEqual(first)
  })

  it.each([
    ['with no call at all', [ask, results(ANTHROPIC)]],
    ['for an id the previous message did not call', [ask, calls(ANTHROPIC), results(GEMINI)]],
    ['answering the same call twice', [ask, calls(ANTHROPIC), results(ANTHROPIC, ANTHROPIC)]],
    [
      'after a typed message',
      [ask, calls(ANTHROPIC), { role: 'user', content: 'wait' }, results(ANTHROPIC)],
    ],
  ] as [string, MessageParam[]][])('refuses a tool result %s', (_name, messages) => {
    expect(() => toChatRequest(params(messages), 'openai')).toThrow(
      expect.objectContaining({ code: 'protocol', message: UNMATCHED_RESULT_MESSAGE }),
    )
  })
})

describe('openai-responses tool id aliasing', () => {
  it('never sends a saved id, and keeps every call_id within 64 characters', () => {
    const { input } = toResponsesRequest(params(history))
    const ids = input.flatMap((item) => ('call_id' in item ? [item.call_id] : []))
    expect(ids).toHaveLength(SAVED.length * 2)
    for (const id of ids) {
      expect(SAVED).not.toContain(id)
      expect(id).toMatch(TOOL_ID_ALIAS)
      expect(id.length).toBeLessThanOrEqual(64)
    }
  })

  it('looks reasoning up by saved id, then sends the call under its alias', () => {
    const asked: string[][] = []
    const { input } = toResponsesRequest(params([ask, calls(UUID)]), 'output', {
      reasoningFor: (ids) => {
        asked.push([...ids])
        return [{ type: 'reasoning', summary: [], encrypted_content: 'opaque' }]
      },
    })
    expect(asked).toEqual([[UUID]])
    expect(input.at(-1)).toMatchObject({ type: 'function_call', call_id: 'call00000' })
  })
})

describe('ids returned for new calls', () => {
  const reserved = savedToolIds(history)

  it('lists every id the history uses', () => {
    expect([...reserved].sort()).toEqual([...SAVED].sort())
  })

  it('keep a fresh provider id, but never reuse a saved id or collide with one', () => {
    const acc = new ChunkAccumulator('m', 'OpenRouter', reserved)
    acc.add({
      id: 'gen-1',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              // A provider reusing a saved id, one echoing an alias, and a fresh id.
              { index: 0, id: ANTHROPIC, function: { name: 'f', arguments: '{}' } },
              { index: 1, id: 'call00000', function: { name: 'g', arguments: '{}' } },
              { index: 2, id: 'call_fresh', function: { name: 'h', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    const ids = acc.finalMessage().content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))
    expect(ids).toHaveLength(3)
    expect(ids[0]).not.toBe(ANTHROPIC)
    expect(ids[0]).toMatch(/^call_[0-9a-f]{24}$/)
    // An alias is never saved for an earlier call, so a returned one is just a new id.
    expect(ids[1]).toBe('call00000')
    expect(ids[2]).toBe('call_fresh')
    expect(new Set([...ids, ...reserved]).size).toBe(ids.length + reserved.size)
  })

  it('do the same on the Responses route', () => {
    const acc = new ResponsesAccumulator('m', new Set(['read_file']), {}, reserved)
    for (const [i, callId] of [UUID, 'call_new'].entries())
      acc.add({
        type: 'response.output_item.done',
        output_index: i,
        item: {
          type: 'function_call',
          id: `fc_${String(i)}`,
          status: 'completed',
          call_id: callId,
          name: 'read_file',
          namespace: 'workspace',
          arguments: '{}',
        },
      })
    acc.add({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
    const ids = acc.finalMessage().content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))
    expect(ids[0]).not.toBe(UUID)
    expect(ids[1]).toBe('call_new')
  })
})
