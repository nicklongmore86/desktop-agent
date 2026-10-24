import Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it, vi } from 'vitest'
import { pngShell } from '../documents/fixtures.test-util'
import { createAgent, createClaudeClient, DEFAULT_MODEL, NO_VISION_NOTE } from './index'
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
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Help', cache_control: { type: 'ephemeral' } }],
        },
      ],
    })
    // The persisted history never carries request-only cache markers.
    expect(JSON.stringify(result.conversation)).not.toContain('cache_control')
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
      // The system breakpoint covers the tools; the last message block gets the other one.
      expect(f.requests[1]?.tools?.[0]).not.toHaveProperty('cache_control')
      const last = f.requests[1]?.messages.at(-1)?.content
      expect(Array.isArray(last) && last.at(-1)).toMatchObject({
        cache_control: { type: 'ephemeral' },
      })
      expect(
        f.requests[1]?.messages
          .slice(0, -1)
          .some((m) => JSON.stringify(m).includes('cache_control')),
      ).toBe(false)
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
    // A failing tool never ends the run: the model gets an error result and continues.
    expect((await f.run()).stopReason).toBe('end_turn')
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]?.messages[2]).toMatchObject({
      content: [{ type: 'tool_result', tool_use_id: 'one', is_error: true }],
    })
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        result: expect.objectContaining({ isError: true }) as unknown,
      }),
    )
    // A thrown error's message never reaches the model or observers.
    expect(JSON.stringify([f.requests, f.events])).not.toContain('private')
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
    const result = await f.run()
    expect(result.stopReason).toBe('end_turn')
    expect(result.conversation[1]?.content).toEqual(reply().content)
    expect(f.requests[1]?.messages[1]?.content).toEqual([
      { ...reply().content[0], cache_control: { type: 'ephemeral' } },
    ])
  })
  it('never executes truncated tool calls and flags the discarded response', async () => {
    const execute = vi.fn()
    const f = fixture([reply('max_tokens', [call()])], [tool(execute)])
    const result = await f.run()
    expect(result.stopReason).toBe('max_tokens')
    expect(result.conversation).toHaveLength(1)
    expect(execute).not.toHaveBeenCalled()
    expect(f.events.map((e) => e.type)).toEqual([
      'text_delta',
      'usage',
      'response_discarded',
      'turn_complete',
      'error',
    ])
    expect(f.events).toContainEqual({ type: 'response_discarded', turn: 1 })
  })
  it('never saves empty text blocks or a message of only empty text', async () => {
    const empty = { type: 'text', text: '', citations: null } as const
    const f = fixture(
      [reply('tool_use', [empty, call()]), reply('end_turn', [empty, { ...empty, text: ' \n' }])],
      [tool()],
    )
    const result = await f.run()
    expect(result.stopReason).toBe('end_turn')
    expect(result.conversation).toHaveLength(3)
    expect(result.conversation[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use' }],
    })
    expect(JSON.stringify(result.conversation)).not.toContain('"text":""')
  })
  it('aborts a pending stream and does not persist partial output', async () => {
    const controller = new AbortController()
    const abort = vi.fn()
    const events: AgentEvent[] = []
    let emitText: (delta: string) => void = () => {}
    const client: AgentClient = {
      messages: {
        stream: () => ({
          abort,
          on: (_event, listener) => {
            emitText = listener
          },
          finalMessage: () =>
            new Promise(() => {
              queueMicrotask(() => {
                emitText('before')
                controller.abort()
                // A late delta from the SDK after the abort must not reach observers.
                emitText('after')
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
    const deltas = events.filter((e) => e.type === 'text_delta')
    expect(deltas).toEqual([{ type: 'text_delta', turn: 1, text: 'before' }])
    expect(events.findIndex((e) => e.type === 'text_delta' && e.text === 'after')).toBe(-1)
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
    // The shape the SDK throws for an SSE `error` event (core/streaming.js).
    const f = fixture([
      new Anthropic.APIError(
        undefined,
        { type: 'error', error: { type, message: 'secret' } },
        undefined,
        new Headers(),
        type,
      ),
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

describe('agent tool images', () => {
  const imageTool = (label: string): AgentTool =>
    tool(() =>
      Promise.resolve({
        content: `read ${label}`,
        images: [{ mime: 'image/png', data: pngShell(4, 4), width: 4, height: 4, label }],
      }),
    )
  const run = async (vision: boolean, steps: number) => {
    const requests: MessageCreateParamsNonStreaming[] = []
    const responses = [
      ...Array.from({ length: steps }, (_, i) => reply('tool_use', [call(`c${String(i)}`)])),
      reply(),
    ]
    let n = 0
    const client: AgentClient = {
      messages: {
        stream(params) {
          requests.push(structuredClone(params))
          const response = responses.shift() ?? reply()
          return {
            abort: () => {},
            on: () => {},
            finalMessage: () => Promise.resolve(response),
          }
        },
      },
    }
    const agent = createAgent({
      client,
      tools: [
        {
          ...imageTool('page'),
          execute: () => {
            n += 1
            return imageTool(`page ${String(n)}`).execute({}, {} as never)
          },
        },
      ],
      vision,
    })
    const result = await agent.run([{ role: 'user', content: 'Read' }], {
      signal: new AbortController().signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: () => {},
    })
    return { requests, result, agent }
  }
  const images = (params: MessageCreateParamsNonStreaming | undefined): string[] =>
    (params?.messages ?? []).flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : message.content.flatMap((block) =>
            block.type === 'tool_result' && Array.isArray(block.content)
              ? block.content.flatMap((part, i, all) => {
                  const label = all[i - 1]
                  return part.type === 'image' && label?.type === 'text' ? [label.text] : []
                })
              : [],
          ),
    )

  it('sends a tool image to a vision model and saves only a note', async () => {
    const { requests, result, agent } = await run(true, 1)
    expect(agent.vision).toBe(true)
    expect(images(requests[1])).toEqual(['[Image: page 1]'])
    const saved = JSON.stringify(result.conversation)
    expect(saved).not.toContain('base64')
    expect(saved).toContain('1 image shown with this result (page 1)')
  })

  it('resends images from the last two tool steps only', async () => {
    const { requests } = await run(true, 4)
    expect(images(requests[1])).toEqual(['[Image: page 1]'])
    expect(images(requests[2])).toEqual(['[Image: page 1]', '[Image: page 2]'])
    expect(images(requests[4])).toEqual(['[Image: page 3]', '[Image: page 4]'])
    // The aged-out step is read as its saved note.
    expect(JSON.stringify(requests[4]?.messages[2])).toContain('call the tool again')
  })

  it('never sends an image without vision, and tells the model why', async () => {
    const { requests, result, agent } = await run(false, 1)
    expect(agent.vision).toBe(false)
    expect(JSON.stringify(requests)).not.toContain('"image"')
    expect(JSON.stringify(result.conversation)).toContain(NO_VISION_NOTE)
  })
})
