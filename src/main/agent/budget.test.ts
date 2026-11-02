import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import { AGENT_BUDGET } from '../../shared/ipc'
import { isWellFormed } from '../storage/conversation-store'
import {
  createAgent,
  createStuckDetector,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  stuckPausedMessage,
  timePausedMessage,
} from './index'
import type { AgentClient, AgentEvent, AgentTool, ToolResult } from './types'

const MINUTE = 60_000

function message(
  stop: Message['stop_reason'],
  content: Message['content'] = [{ type: 'text', text: 'Done', citations: null }],
): Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_MODEL,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Message
}

/** A step asking for these calls ([name, input] pairs); `null` ends the reply. */
type Step = [string, unknown][] | null

/** A model that takes the scripted steps in order, then (or at `null`) ends its reply. */
function scripted(steps: Step[]): { client: AgentClient; requests: () => number } {
  let requests = 0
  const client: AgentClient = {
    messages: {
      stream() {
        const turn = requests++
        const step = steps[turn] ?? null
        const reply = step
          ? message(
              'tool_use',
              step.map(([name, input], index) => ({
                type: 'tool_use',
                caller: { type: 'direct' },
                id: `t${String(turn)}-${String(index)}`,
                name,
                input,
              })),
            )
          : message('end_turn')
        return { abort: () => {}, on: () => {}, finalMessage: () => Promise.resolve(reply) }
      },
    },
  }
  return { client, requests: () => requests }
}

const named = (name: string, execute: AgentTool['execute']): AgentTool => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  execute,
})

async function runWith(
  options: Parameters<typeof createAgent>[0],
  requestApproval: () => Promise<boolean> = () => Promise.resolve(false),
) {
  const events: AgentEvent[] = []
  const result = await createAgent(options).run([{ role: 'user', content: 'Help' }], {
    signal: new AbortController().signal,
    requestApproval,
    onEvent: (event) => events.push(event),
  })
  const errors = events.filter((event) => event.type === 'error')
  return { result, events, errors }
}

/** Every tool call in the history has its result in the next message. */
function paired(conversation: MessageParam[]): boolean {
  return isWellFormed(conversation) && conversation.at(-1)?.role === 'user'
}

const repeat = <T>(times: number, value: T): T[] => Array.from({ length: times }, () => value)

describe('time budget', () => {
  it('pauses between steps once 20 minutes of work are used, naming the time budget', async () => {
    let clock = 0
    const { client, requests } = scripted(
      Array.from({ length: 10 }, (_, i): Step => [['work', { part: i }]]),
    )
    // Each step takes six minutes: 24 minutes have passed after four.
    const work = named('work', () => {
      clock += 6 * MINUTE
      return Promise.resolve({ content: `part done at ${String(clock)}` })
    })
    const { result, errors } = await runWith({
      client,
      tools: [work],
      maxTurns: 10,
      now: () => clock,
    })
    expect(result.stopReason).toBe('max_turns')
    expect(requests()).toBe(4)
    expect(errors).toEqual([
      {
        type: 'error',
        code: 'max_turns',
        message:
          'Paused after 20 minutes of work on this message (the time budget). Your progress is saved.',
      },
    ])
    expect(errors[0]?.message).toBe(timePausedMessage(AGENT_BUDGET.minutes))
    // The prompt, then four answered calls.
    expect(result.conversation).toHaveLength(1 + 4 * 2)
    expect(paired(result.conversation)).toBe(true)
  })

  it('does not pause a run that finishes inside the budget', async () => {
    let clock = 0
    const { client } = scripted([[['work', {}]], [['work', { more: true }]]])
    const work = named('work', (input) => {
      clock += 9 * MINUTE
      return Promise.resolve({ content: JSON.stringify(input) })
    })
    const { result, errors } = await runWith({ client, tools: [work], now: () => clock })
    expect(result.stopReason).toBe('end_turn')
    expect(errors).toEqual([])
  })

  it('leaves out time spent waiting for the user to answer an approval', async () => {
    let clock = 0
    const { client, requests } = scripted([
      [['write', { name: 'a' }]],
      [['write', { name: 'b' }]],
      [['write', { name: 'c' }]],
    ])
    const write = named('write', async (input: { name: string }, ctx) => {
      clock += MINUTE
      const approved = await ctx.requestApproval({
        tool: 'write',
        kind: 'write',
        summary: `Write ${input.name}`,
      })
      return { content: approved ? `wrote ${input.name}` : 'declined', isError: !approved }
    })
    // The user takes half an hour to answer each approval.
    const { result, errors } = await runWith({ client, tools: [write], now: () => clock }, () => {
      clock += 30 * MINUTE
      return Promise.resolve(true)
    })
    expect(errors).toEqual([])
    expect(result.stopReason).toBe('end_turn')
    expect(requests()).toBe(4)
  })

  it('refuses a budget that is not a positive whole number of milliseconds', () => {
    const { client } = scripted([])
    for (const timeBudgetMs of [0, -1, 1.5, Number.NaN])
      expect(() => createAgent({ client, tools: [], timeBudgetMs })).toThrow(/timeBudgetMs/)
  })
})

describe('stuck detection', () => {
  it('pauses when the same call returns the same result 3 times, after pairing results', async () => {
    const { client, requests } = scripted(repeat(10, [['read', { path: 'a', lines: 5 }]]))
    const read = named('read', () => Promise.resolve({ content: 'same text' }))
    const { result, errors } = await runWith({ client, tools: [read] })
    expect(requests()).toBe(3)
    expect(result.stopReason).toBe('max_turns')
    expect(errors).toEqual([
      {
        type: 'error',
        code: 'max_turns',
        message:
          'Paused because the agent appears stuck: read returned the same result for the same request 3 times. Your progress is saved.',
      },
    ])
    expect(result.conversation).toHaveLength(1 + 3 * 2)
    expect(paired(result.conversation)).toBe(true)
  })

  it('counts repeats anywhere in the message, and matches inputs whatever their key order', async () => {
    const { client, requests } = scripted([
      [['read', { path: 'a', lines: 5 }]],
      [['read', { path: 'b' }]],
      [['read', { lines: 5, path: 'a' }]],
      [['read', { path: 'c' }]],
      [['read', { path: 'a', lines: 5 }]],
      [['read', { path: 'd' }]],
    ])
    const read = named('read', (input: { path: string }) =>
      Promise.resolve({ content: `text of ${input.path}` }),
    )
    const { result, errors } = await runWith({ client, tools: [read] })
    expect(requests()).toBe(5)
    expect(result.stopReason).toBe('max_turns')
    expect(errors[0]?.message).toBe(stuckPausedMessage({ kind: 'repeat', tool: 'read' }))
  })

  it('never pauses a continuation that reports new progress each time', async () => {
    // search_files continuing a search: the same arguments, a different result each time.
    const { client } = scripted(repeat(8, [['search_files', { path: 'C:/docs', query: 'tax' }]]))
    let searched = 0
    const search = named('search_files', () =>
      Promise.resolve({ content: `${String((searched += 50))} documents searched, more to go` }),
    )
    const { result, errors } = await runWith({ client, tools: [search] })
    expect(errors).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  it('never pauses calls that return the same result for different inputs', async () => {
    const { client } = scripted(
      Array.from({ length: 6 }, (_, i): Step => [['read', { path: `file${String(i)}` }]]),
    )
    const read = named('read', () => Promise.resolve({ content: 'empty file' }))
    const { result, errors } = await runWith({ client, tools: [read] })
    expect(errors).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  it('pauses after 3 steps in a row where every tool call failed', async () => {
    const { client, requests } = scripted(
      Array.from({ length: 10 }, (_, i): Step => [
        ['read', { path: `missing${String(i)}` }],
        ['read', { path: `gone${String(i)}` }],
      ]),
    )
    const read = named('read', (input: { path: string }) =>
      Promise.resolve({ content: `${input.path} does not exist`, isError: true }),
    )
    const { result, errors } = await runWith({ client, tools: [read] })
    expect(requests()).toBe(3)
    expect(result.stopReason).toBe('max_turns')
    expect(errors).toEqual([
      {
        type: 'error',
        code: 'max_turns',
        message:
          'Paused because the agent appears stuck: every tool call failed in 3 steps in a row. Your progress is saved.',
      },
    ])
    expect(paired(result.conversation)).toBe(true)
  })

  it('does not count failures that are not in a row, or steps where one call worked', async () => {
    const steps: Step[] = [
      [['read', { path: 'x1' }]],
      [['read', { path: 'x2' }]],
      [['read', { path: 'ok' }]],
      [['read', { path: 'x3' }]],
      [
        ['read', { path: 'x4' }],
        ['read', { path: 'ok2' }],
      ],
      [['read', { path: 'x5' }]],
      [['read', { path: 'x6' }]],
    ]
    const { client } = scripted(steps)
    const read = named('read', (input: { path: string }) =>
      Promise.resolve({ content: `result for ${input.path}`, isError: input.path.startsWith('x') }),
    )
    const { result, errors } = await runWith({ client, tools: [read] })
    expect(errors).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  it('never treats calls the user declined as stuck', async () => {
    const { client } = scripted(repeat(5, [['delete', { path: 'a' }]]))
    const remove = named('delete', () =>
      Promise.resolve({ content: 'The user declined.', isError: true, declined: true }),
    )
    const { result, errors } = await runWith({ client, tools: [remove] })
    expect(errors).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  it('starts again for each message', async () => {
    const read = named('read', () => Promise.resolve({ content: 'same text' }))
    const steps: Step[] = repeat(2, [['read', { path: 'a' }]])
    const { client } = scripted([...steps, null, ...steps, null])
    const agent = createAgent({ client, tools: [read] })
    for (let message = 0; message < 2; message++) {
      const events: AgentEvent[] = []
      const result = await agent.run([{ role: 'user', content: 'Help' }], {
        signal: new AbortController().signal,
        requestApproval: () => Promise.resolve(false),
        onEvent: (event) => events.push(event),
      })
      expect(result.stopReason).toBe('end_turn')
      expect(events.filter((event) => event.type === 'error')).toEqual([])
    }
  })

  it("never shows a name the model made up: only a real tool's", async () => {
    const { client } = scripted(repeat(5, [['Click <here> now', {}]]))
    const { errors } = await runWith({ client, tools: [] })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(stuckPausedMessage({ kind: 'repeat', tool: 'an unknown tool' }))
    expect(errors[0]?.message).not.toContain('Click')
  })

  it('compares images as well as text', () => {
    const detector = createStuckDetector(2)
    const image = (byte: number): ToolResult => ({
      content: 'page 1',
      images: [{ mime: 'image/png', data: new Uint8Array([byte]), width: 1, height: 1 }],
    })
    const calls = [{ name: 'read', input: { path: 'scan.pdf' } }]
    expect(detector.step(calls, [image(1)], () => true)).toBeNull()
    expect(detector.step(calls, [image(2)], () => true)).toBeNull()
    expect(detector.step(calls, [image(2)], () => true)).toBe(
      stuckPausedMessage({ kind: 'repeat', tool: 'read' }, 2),
    )
  })
})

describe('system prompt', () => {
  it('asks for efficient, independent work without naming parameters that may not exist', () => {
    for (const phrase of [
      'make them in the same response',
      'Search before opening files',
      'read_document',
      'Run one search_files call at a time, never several in parallel',
      'narrow the search to a subfolder or a file-name pattern',
      'Finish the task without stopping to ask',
    ])
      expect(DEFAULT_SYSTEM_PROMPT).toContain(phrase)
    // Provider-neutral, and no parameter names that other changes may not have added yet.
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/\bClaude\b|\bGPT\b|\bpaths\b|\bcontext:/)
  })
})
