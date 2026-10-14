import Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it, vi } from 'vitest'
import { createAgent, createClaudeClient, DEFAULT_MODEL } from './index'
import type { AgentClient, AgentEvent, AgentTool } from './types'

function reply(
  stop: Message['stop_reason'] = 'end_turn',
  content: Message['content'] = [{ type: 'text', text: 'Hello', citations: null }],
): Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_MODEL,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Message
}
function fixture(responses: (Message | Error)[], tools: AgentTool[] = [], maxTurns = 10) {
  const requests: MessageCreateParamsNonStreaming[] = []
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const abort = vi.fn()
  const client: AgentClient = {
    messages: {
      stream(params) {
        requests.push(structuredClone(params))
        const response = responses.shift()
        return {
          abort,
          on(_event, listener) {
            listener('Hello')
          },
          finalMessage() {
            return response instanceof Error
              ? Promise.reject(response)
              : Promise.resolve(response ?? reply())
          },
        }
      },
    },
  }
  const agent = createAgent({ client, tools, maxTurns })
  const run = () =>
    agent.run([{ role: 'user', content: 'Help' }], {
      signal: controller.signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: (event) => events.push(event),
    })
  return { run, agent, requests, events, controller, abort }
}
const call = (id = 'one', name = 'read'): Message['content'][number] => ({
  type: 'tool_use',
  caller: { type: 'direct' },
  id,
  name,
  input: { path: 'a' },
})
const tool = (
  execute: AgentTool['execute'] = () => Promise.resolve({ content: 'ok' }),
): AgentTool => ({
  name: 'read',
  description: 'Read',
  inputSchema: { type: 'object', properties: {} },
  execute,
})

describe('agent', () => {
  it('streams text and returns persistable history, usage and cache boundaries', async () => {
    const f = fixture([reply()])
    const result = await f.run()
    expect(result.stopReason).toBe('end_turn')
    expect(result.conversation).toHaveLength(2)
    expect(f.events.map((e) => e.type)).toEqual(['text_delta', 'usage', 'turn_complete'])
    expect(f.requests[0]).toMatchObject({
      model: DEFAULT_MODEL,
      system: [{ cache_control: { type: 'ephemeral' } }],
    })
    expect(createClaudeClient('test')).toBeInstanceOf(Anthropic)
  })
  it.each([1, 2])(
    'executes %i tool calls and submits all results in one message',
    async (count) => {
      const execute = vi.fn(() => Promise.resolve({ content: 'ok' }))
      const f = fixture(
        [
          reply(
            'tool_use',
            Array.from({ length: count }, (_, i) => call(String(i))),
          ),
          reply(),
        ],
        [tool(execute)],
      )
      await f.run()
      expect(execute).toHaveBeenCalledTimes(count)
      expect(f.requests[1]?.messages[2]).toMatchObject({
        role: 'user',
        content: Array.from({ length: count }, (_, i) => ({
          type: 'tool_result',
          tool_use_id: String(i),
          content: 'ok',
          is_error: false,
        })),
      })
      expect(f.requests[0]?.tools?.[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    },
  )
  it('starts parallel calls before either resolves', async () => {
    const releases: (() => void)[] = []
    const f = fixture(
      [reply('tool_use', [call('a'), call('b')]), reply()],
      [
        tool(
          () =>
            new Promise((resolve) => {
              releases.push(() => {
                resolve({ content: 'ok' })
              })
              if (releases.length === 2)
                releases.forEach((release) => {
                  release()
                })
            }),
        ),
      ],
    )
    expect((await f.run()).stopReason).toBe('end_turn')
    expect(releases).toHaveLength(2)
  })
  it.each(['throw', 'reported', 'unknown'])('returns an error result for %s', async (mode) => {
    const f = fixture(
      [reply('tool_use', [call()]), reply()],
      mode === 'unknown'
        ? []
        : [
            tool(() =>
              mode === 'throw'
                ? Promise.reject(new Error('private'))
                : Promise.resolve({ content: 'failure', isError: true }),
            ),
          ],
    )
    await f.run()
    expect(f.requests[1]?.messages[2]).toMatchObject({ content: [{ is_error: true }] })
  })
  it('emits approval denial and lets the tool report it', async () => {
    const f = fixture(
      [reply('tool_use', [call()]), reply()],
      [
        tool(async (_input, ctx) => ({
          content: (await ctx.requestApproval({
            tool: 'read',
            kind: 'write',
            summary: 'Write file',
          }))
            ? 'written'
            : 'denied',
          isError: true,
        })),
      ],
    )
    await f.run()
    expect(f.events).toContainEqual({
      type: 'approval_resolved',
      turn: 1,
      id: 'one',
      approved: false,
    })
    expect(f.requests[1]?.messages[2]).toMatchObject({ content: [{ content: 'denied' }] })
  })
  it('cuts off at maxTurns after pairing tool results', async () => {
    const f = fixture([reply('tool_use', [call()])], [tool()], 1)
    expect(await f.run()).toMatchObject({ stopReason: 'max_turns', conversation: [{}, {}, {}] })
    expect(f.requests).toHaveLength(1)
  })
  it.each(['max_tokens', 'refusal', 'model_context_window_exceeded', 'stop_sequence'] as const)(
    'handles %s without retry',
    async (stop) => {
      const f = fixture([reply(stop)])
      expect((await f.run()).stopReason).toBe(
        stop === 'model_context_window_exceeded' ? 'context_limit' : stop,
      )
      expect(f.requests).toHaveLength(1)
    },
  )
  it('continues pause_turn with unchanged assistant content', async () => {
    const f = fixture([reply('pause_turn'), reply()])
    expect((await f.run()).stopReason).toBe('end_turn')
    expect(f.requests[1]?.messages[1]?.content).toEqual(reply().content)
  })
  it('never executes truncated tool calls', async () => {
    const execute = vi.fn()
    const f = fixture([reply('max_tokens', [call()])], [tool(execute)])
    expect((await f.run()).stopReason).toBe('max_tokens')
    expect(execute).not.toHaveBeenCalled()
  })
  it('aborts a pending stream and does not persist partial output', async () => {
    const controller = new AbortController()
    const abort = vi.fn()
    const events: AgentEvent[] = []
    const client: AgentClient = {
      messages: {
        stream: () => ({
          abort,
          on: () => {},
          finalMessage: () =>
            new Promise(() => {
              queueMicrotask(() => {
                controller.abort()
              })
            }),
        }),
      },
    }
    const result = await createAgent({ client, tools: [] }).run([], {
      signal: controller.signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: (e) => events.push(e),
    })
    expect(result).toEqual({ stopReason: 'aborted', conversation: [] })
    expect(abort).toHaveBeenCalledOnce()
    expect(events).toContainEqual({
      type: 'error',
      code: 'aborted',
      message: 'Agent run cancelled.',
    })
  })
  it.each(['tool', 'approval'])('aborts pending %s and retains paired results', async (pending) => {
    const f = fixture(
      [reply('tool_use', [call()])],
      [
        tool(async (_input, ctx) => {
          queueMicrotask(() => {
            f.controller.abort()
          })
          if (pending === 'approval')
            await ctx.requestApproval({ tool: 'read', kind: 'write', summary: 'write' })
          return new Promise(() => {})
        }),
      ],
    )
    expect(await f.run()).toMatchObject({
      stopReason: 'aborted',
      conversation: [{}, {}, { content: [{ is_error: true }] }],
    })
  })
  it.each([
    [401, 'authentication'],
    [429, 'rate_limit'],
    [529, 'overloaded'],
    [500, 'api'],
  ] as const)('maps HTTP %i safely', async (status, code) => {
    const f = fixture([
      Anthropic.APIError.generate(status, { message: 'secret' }, 'secret', new Headers()),
    ])
    expect((await f.run()).stopReason).toBe(code)
    expect(JSON.stringify(f.events)).not.toContain('secret')
  })
  it('maps connection failures', async () => {
    expect((await fixture([new Anthropic.APIConnectionError({})]).run()).stopReason).toBe('network')
  })
  it.each(['end_turn', 'stop_sequence'] as const)(
    'omits empty %s replies after tool results',
    async (stop) => {
      const f = fixture([reply('tool_use', [call()]), reply(stop, [])], [tool()])
      const result = await f.run()
      expect(result.stopReason).toBe(stop)
      expect(result.conversation).toHaveLength(3)
      expect(result.conversation.at(-1)).toMatchObject({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'one' }],
      })
      expect(
        result.conversation.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.length === 0,
        ),
      ).toBe(false)
    },
  )
  it('preserves tool/result pairing when every observer callback throws', async () => {
    const f = fixture(
      [reply('tool_use', [call()]), reply()],
      [
        tool(async (_input, ctx) => {
          await ctx.requestApproval({ tool: 'read', kind: 'write', summary: 'Write' })
          return { content: 'denied', isError: true }
        }),
      ],
    )
    const onEvent = vi.fn(() => {
      throw new Error('Observer failure')
    })
    const result = await f.agent.run([{ role: 'user', content: 'Help' }], {
      signal: f.controller.signal,
      requestApproval: () => Promise.resolve(false),
      onEvent,
    })
    expect(result.stopReason).toBe('end_turn')
    expect(result.conversation[2]).toMatchObject({
      role: 'user',
      content: [{ tool_use_id: 'one', content: 'denied' }],
    })
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval_resolved' }))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result' }))
  })
  it.each([
    ['overloaded_error', 'overloaded'],
    ['rate_limit_error', 'rate_limit'],
  ] as const)('maps statusless stream %s', async (type, code) => {
    const f = fixture([
      new Anthropic.APIError(undefined, { type, message: 'secret' }, 'secret', undefined),
    ])
    expect((await f.run()).stopReason).toBe(code)
    expect(JSON.stringify(f.events)).not.toContain('secret')
  })
  it.each([
    [400, 'invalid_request'],
    [404, 'invalid_request'],
    [413, 'invalid_request'],
    [403, 'permission'],
  ] as const)('maps non-retryable HTTP %i', async (status, code) => {
    const f = fixture([
      Anthropic.APIError.generate(status, { message: 'secret' }, 'secret', new Headers()),
    ])
    expect((await f.run()).stopReason).toBe(code)
    const event = f.events.find((event) => event.type === 'error')
    expect(event?.message).not.toMatch(/try again|secret/i)
  })
})
