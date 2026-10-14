import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalPrompt, ChatEvent } from '../../shared/ipc'
import { createAgent, type AgentClient, type AgentTool, type RunOptions } from '../agent'
import type { ConversationStore } from '../storage/conversation-store'
import { ChatSession, type AgentRunner, type RunnerResult } from './session'

function memoryStore(initial: MessageParam[] = []) {
  let saved = structuredClone(initial)
  const store: ConversationStore & { saved(): MessageParam[] } = {
    load: vi.fn(() => Promise.resolve({ messages: structuredClone(saved), error: null })),
    save: vi.fn((messages: MessageParam[]) => {
      saved = structuredClone(messages)
      return Promise.resolve()
    }),
    clear: vi.fn(() => {
      saved = []
      return Promise.resolve()
    }),
    saved: () => saved,
  }
  return store
}

/** A fake agent that runs `script` with the session's run options. */
function scriptedRunner(
  script: (conversation: MessageParam[], options: RunOptions) => Promise<MessageParam[]>,
): AgentRunner {
  return {
    async run(conversation, options) {
      const history = await script(structuredClone(conversation), options)
      return {
        conversation: history,
        stopReason: options.signal.aborted ? 'aborted' : 'end_turn',
      }
    },
  }
}

function setup(
  runner: AgentRunner | RunnerResult,
  initial: MessageParam[] = [],
  store = memoryStore(initial),
  emit?: (event: ChatEvent) => void,
) {
  const events: ChatEvent[] = []
  const prompts: ApprovalPrompt[] = []
  let n = 0
  const createRunner = vi.fn(() =>
    Promise.resolve<RunnerResult>('ok' in runner ? runner : { ok: true, runner }),
  )
  const session = new ChatSession({
    store,
    createRunner,
    emit: (event) => {
      events.push(event)
      emit?.(event)
    },
    promptApproval: (prompt) => prompts.push(prompt),
    newId: () => `id-${String(++n)}`,
  })
  return { session, events, prompts, store, createRunner }
}

const reply = (text: string): MessageParam => ({ role: 'assistant', content: text })

/** Waits until `predicate` holds, flushing microtasks and timers in between. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 0))
  expect(predicate()).toBe(true)
}

/** A runner whose only step is one approval request; records the decision. */
function approvalRunner() {
  const decisions: boolean[] = []
  const runner = scriptedRunner(async (history, options) => {
    options.onEvent({
      type: 'approval_requested',
      turn: 1,
      id: 'toolu_1',
      request: { tool: 'write_file', kind: 'write', summary: 'Write a.txt', detail: '+hi' },
    })
    decisions.push(
      await options.requestApproval({
        tool: 'write_file',
        kind: 'write',
        summary: 'Write a.txt',
        detail: '+hi',
      }),
    )
    return [...history, reply('done')]
  })
  return { runner, decisions }
}

describe('ChatSession', () => {
  it('streams a run, persists the history and reports the transcript', async () => {
    const runner = scriptedRunner((history, options) => {
      options.onEvent({ type: 'text_delta', turn: 1, text: 'Hel' })
      options.onEvent({ type: 'text_delta', turn: 1, text: 'lo' })
      options.onEvent({ type: 'usage', turn: 1, usage: {} as Message['usage'] })
      return Promise.resolve([...history, reply('Hello')])
    })
    const { session, events, store } = setup(runner)
    await session.init()
    expect(await session.send('Hi')).toEqual({ ok: true })
    await session.idle()
    expect(events).toEqual([
      { type: 'run_started', runId: 'id-1', text: 'Hi' },
      { type: 'text_delta', runId: 'id-1', turn: 1, text: 'Hel' },
      { type: 'text_delta', runId: 'id-1', turn: 1, text: 'lo' },
      { type: 'run_finished', runId: 'id-1', stopReason: 'end_turn' },
    ])
    expect(store.saved()).toEqual([{ role: 'user', content: 'Hi' }, reply('Hello')])
    expect(session.state()).toMatchObject({
      running: false,
      items: [
        { kind: 'user', text: 'Hi' },
        { kind: 'assistant', text: 'Hello' },
      ],
    })
  })

  it('loads the saved conversation and continues it', async () => {
    const seen: MessageParam[][] = []
    const runner = scriptedRunner((history) => {
      seen.push(history)
      return Promise.resolve([...history, reply('again')])
    })
    const { session } = setup(runner, [{ role: 'user', content: 'Earlier' }, reply('Before')])
    await session.init()
    expect(session.state().items).toHaveLength(2)
    await session.send('Next')
    await session.idle()
    expect(seen[0]).toEqual([
      { role: 'user', content: 'Earlier' },
      reply('Before'),
      { role: 'user', content: 'Next' },
    ])
  })

  it('runs one at a time', async () => {
    let finish: () => void = () => {}
    const runner = scriptedRunner(
      (history) =>
        new Promise((resolve) => {
          finish = () => {
            resolve(history)
          }
        }),
    )
    const { session } = setup(runner)
    const [first, second] = await Promise.all([session.send('a'), session.send('b')])
    expect(first).toEqual({ ok: true })
    expect(second).toMatchObject({ ok: false, code: 'busy' })
    expect(session.running).toBe(true)
    finish()
    await session.idle()
    expect(session.running).toBe(false)
    expect(await session.send('c')).toEqual({ ok: true })
  })

  it('rejects empty or non-string messages without starting a run', async () => {
    const { session, createRunner } = setup(scriptedRunner((h) => Promise.resolve(h)))
    for (const text of ['', '   ', 42, null]) {
      expect(await session.send(text)).toMatchObject({ ok: false, code: 'invalid_request' })
    }
    expect(createRunner).not.toHaveBeenCalled()
    expect(session.running).toBe(false)
  })

  it('reports a missing API key without touching the conversation', async () => {
    const { session, events, store } = setup({
      ok: false,
      code: 'no_api_key',
      message: 'Add your Anthropic API key in Settings.',
    })
    expect(await session.send('Hi')).toEqual({
      ok: false,
      code: 'no_api_key',
      message: 'Add your Anthropic API key in Settings.',
    })
    expect(events).toEqual([])
    expect(store.save).not.toHaveBeenCalled()
    expect(session.running).toBe(false)
  })

  it('reports a crashing runner as an internal error', async () => {
    const { session, events } = setup({
      run: () => Promise.reject(new Error('boom: secret detail')),
    })
    await session.send('Hi')
    await session.idle()
    expect(events.slice(1)).toEqual([
      {
        type: 'error',
        runId: 'id-1',
        code: 'internal',
        message: 'The agent stopped unexpectedly.',
      },
      { type: 'run_finished', runId: 'id-1', stopReason: 'internal' },
    ])
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  it('forwards discarded responses and agent errors', async () => {
    const runner = scriptedRunner((history, options) => {
      options.onEvent({ type: 'text_delta', turn: 1, text: 'partial' })
      options.onEvent({ type: 'response_discarded', turn: 1 })
      options.onEvent({ type: 'error', code: 'max_tokens', message: 'Too long.' })
      return Promise.resolve(history)
    })
    const { session, events } = setup(runner)
    await session.send('Hi')
    await session.idle()
    expect(events).toContainEqual({ type: 'response_discarded', runId: 'id-1', turn: 1 })
    expect(events).toContainEqual({
      type: 'error',
      runId: 'id-1',
      code: 'max_tokens',
      message: 'Too long.',
    })
  })

  describe('approvals', () => {
    it('prompts with a random id and the tool call, and resolves only that id', async () => {
      const { runner, decisions } = approvalRunner()
      const { session, prompts, events } = setup(runner)
      await session.send('Write it')
      await until(() => prompts.length === 1)
      expect(prompts[0]).toEqual({
        id: 'id-2',
        runId: 'id-1',
        toolUseId: 'toolu_1',
        tool: 'write_file',
        kind: 'write',
        summary: 'Write a.txt',
        detail: '+hi',
      })
      // Unknown ids, wrong types and the run id itself are all ignored.
      expect(session.respondApproval('id-999', true)).toBe(false)
      expect(session.respondApproval('id-1', true)).toBe(false)
      expect(session.respondApproval(2, true)).toBe(false)
      expect(session.respondApproval({ id: 'id-2' }, true)).toBe(false)
      expect(session.pendingApprovals).toEqual(['id-2'])
      expect(decisions).toEqual([])

      expect(session.respondApproval('id-2', true)).toBe(true)
      await session.idle()
      expect(decisions).toEqual([true])
      expect(events).toContainEqual({ type: 'approval_closed', approvalId: 'id-2', approved: true })
      // A second answer to a settled id changes nothing.
      expect(session.respondApproval('id-2', false)).toBe(false)
    })

    it.each([['yes'], [1], [null], [undefined], [{}]])(
      'treats approved=%j as a denial',
      async (approved) => {
        const { runner, decisions } = approvalRunner()
        const { session, prompts } = setup(runner)
        await session.send('Write it')
        await until(() => prompts.length === 1)
        expect(session.respondApproval(prompts[0]?.id, approved)).toBe(true)
        await session.idle()
        expect(decisions).toEqual([false])
      },
    )

    it('denies pending approvals on stop and ends the run', async () => {
      const { runner, decisions } = approvalRunner()
      const { session, prompts, events } = setup(runner)
      await session.send('Write it')
      await until(() => prompts.length === 1)
      await session.stop()
      expect(decisions).toEqual([false])
      expect(session.pendingApprovals).toEqual([])
      expect(session.running).toBe(false)
      expect(events).toContainEqual({
        type: 'approval_closed',
        approvalId: 'id-2',
        approved: false,
      })
      expect(events.at(-1)).toEqual({ type: 'run_finished', runId: 'id-1', stopReason: 'aborted' })
    })

    it('denies pending approvals on new chat and starts empty', async () => {
      const { runner, decisions } = approvalRunner()
      const { session, prompts, events, store } = setup(runner, [{ role: 'user', content: 'old' }])
      await session.init()
      await session.send('Write it')
      await until(() => prompts.length === 1)
      const state = await session.newChat()
      expect(decisions).toEqual([false])
      expect(state).toEqual({ items: [], running: false, loadError: null })
      expect(store.clear).toHaveBeenCalledOnce()
      expect(store.saved()).toEqual([])
      expect(events.at(-1)).toEqual({ type: 'conversation_reset' })
    })

    it('refuses approval requests from a run that has ended', async () => {
      let late: RunOptions | null = null
      const runner = scriptedRunner((history, options) => {
        late = options
        return Promise.resolve(history)
      })
      const { session, prompts } = setup(runner)
      await session.send('Hi')
      await session.idle()
      const decision = await (late as RunOptions | null)?.requestApproval({
        tool: 'run_shell',
        kind: 'shell',
        summary: 'late',
      })
      expect(decision).toBe(false)
      expect(prompts).toEqual([])
    })
  })

  it('works end to end with the real agent loop and a tool needing approval', async () => {
    const responses: Message[] = [
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'test',
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'run_shell', input: { command: 'ls' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Message,
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'test',
        content: [{ type: 'text', text: 'Declined, so nothing ran.', citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Message,
    ]
    const client: AgentClient = {
      messages: {
        stream: () => {
          const message = responses.shift()
          return {
            abort: () => {},
            on: (_event, listener) => {
              const first = message?.content[0]
              if (first?.type === 'text') listener(first.text)
            },
            finalMessage: () =>
              message ? Promise.resolve(message) : Promise.reject(new Error('no more')),
          }
        },
      },
    }
    const ran = vi.fn()
    const shellTool: AgentTool = {
      name: 'run_shell',
      description: 'Run',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      async execute(_input, ctx) {
        const approved = await ctx.requestApproval({
          tool: 'run_shell',
          kind: 'shell',
          summary: 'Run a command in /work',
          detail: 'cwd: /work\nshell: /bin/sh -c\n\nls',
        })
        if (!approved) return { content: 'The user declined.', isError: true }
        ran()
        return { content: 'ok' }
      },
    }
    const { session, prompts, events, store } = setup(createAgent({ client, tools: [shellTool] }))
    await session.send('List files')
    await until(() => prompts.length === 1)
    expect(prompts[0]).toMatchObject({
      toolUseId: 'toolu_x',
      kind: 'shell',
      detail: 'cwd: /work\nshell: /bin/sh -c\n\nls',
    })
    session.respondApproval(prompts[0]?.id, false)
    await session.idle()
    expect(ran).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      type: 'tool_result',
      runId: 'id-1',
      id: 'toolu_x',
      content: 'The user declined.',
      isError: true,
    })
    expect(store.saved()).toHaveLength(4)
    expect(session.state().items).toMatchObject([
      { kind: 'user', text: 'List files' },
      {
        kind: 'tool',
        id: 'toolu_x',
        name: 'run_shell',
        result: { content: 'The user declined.', isError: true },
      },
      { kind: 'assistant', text: 'Declined, so nothing ran.' },
    ])
  })

  describe('new chat', () => {
    /** A store whose clear() waits until `finishClear()` is called. */
    function slowClearStore(initial: MessageParam[] = []) {
      const store = memoryStore(initial)
      const finishes: (() => void)[] = []
      let clearing = 0
      let maxConcurrent = 0
      const clearNow = store.clear
      store.clear = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            clearing += 1
            maxConcurrent = Math.max(maxConcurrent, clearing)
            finishes.push(() => {
              clearing -= 1
              void clearNow().then(resolve)
            })
          }),
      )
      return {
        store,
        finishClear: () => finishes.shift()?.(),
        pendingClears: () => finishes.length,
        maxConcurrent: () => maxConcurrent,
      }
    }

    it('refuses send while a reset is in progress and resets only after the clear', async () => {
      const slow = slowClearStore([{ role: 'user', content: 'old' }])
      const { session, events, createRunner } = setup(
        scriptedRunner((h) => Promise.resolve([...h, reply('ok')])),
        [],
        slow.store,
      )
      await session.init()
      const reset = session.newChat()
      // Reserved synchronously: a send in the same tick is already refused.
      expect(await session.send('racing')).toEqual({
        ok: false,
        code: 'busy',
        message: 'A new chat is being started. Try again.',
      })
      await until(() => slow.pendingClears() === 1)
      expect(await session.send('still racing')).toMatchObject({ ok: false, code: 'busy' })
      expect(events).not.toContainEqual({ type: 'conversation_reset' })
      expect(createRunner).not.toHaveBeenCalled()

      slow.finishClear()
      expect(await reset).toEqual({ items: [], running: false, loadError: null })
      expect(events.at(-1)).toEqual({ type: 'conversation_reset' })
      expect(slow.store.saved()).toEqual([])
      expect(await session.send('after')).toEqual({ ok: true })
    })

    it('runs repeated New chat calls one after another', async () => {
      const slow = slowClearStore()
      const { session, events } = setup(
        scriptedRunner((h) => Promise.resolve(h)),
        [],
        slow.store,
      )
      const first = session.newChat()
      const second = session.newChat()
      await until(() => slow.pendingClears() === 1)
      // The second clear has not started: the first has not finished.
      expect(slow.store.clear).toHaveBeenCalledOnce()
      slow.finishClear()
      await first
      await until(() => slow.pendingClears() === 1)
      expect(await session.send('too early')).toMatchObject({ ok: false, code: 'busy' })
      slow.finishClear()
      await second
      expect(slow.maxConcurrent()).toBe(1)
      expect(events.filter((e) => e.type === 'conversation_reset')).toHaveLength(2)
      expect(await session.send('now')).toEqual({ ok: true })
    })

    it('never lets a run save history after a reset, even if it ignores the abort', async () => {
      let finish: () => void = () => {}
      const runner = scriptedRunner(
        (history) =>
          new Promise((resolve) => {
            // Ignores the signal and returns a longer history later.
            finish = () => {
              resolve([...history, reply('late answer')])
            }
          }),
      )
      const { session, store } = setup(runner)
      await session.send('Hi')
      const reset = session.newChat()
      finish()
      await reset
      await session.idle()
      expect(store.saved()).toEqual([])
      expect(session.state().items).toEqual([])
    })

    it('stops a send that is still saving the user message when a reset starts', async () => {
      const store = memoryStore()
      let finishSave: () => void = () => {}
      store.save = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve
          }),
      )
      const run = vi.fn()
      const { session, events } = setup({ run }, [], store)
      const sending = session.send('Hi')
      await until(() => vi.mocked(store.save).mock.calls.length === 1)
      const reset = session.newChat()
      finishSave()
      expect(await sending).toMatchObject({ ok: false, code: 'aborted' })
      await reset
      expect(run).not.toHaveBeenCalled()
      expect(events.some((e) => e.type === 'run_started')).toBe(false)
      expect(store.clear).toHaveBeenCalledOnce()
    })

    it('warns when the saved conversation cannot be deleted', async () => {
      const store = memoryStore()
      store.clear = vi.fn(() => Promise.reject(new Error('EPERM')))
      const { session, events } = setup(
        scriptedRunner((h) => Promise.resolve(h)),
        [],
        store,
      )
      await session.newChat()
      expect(events).toEqual([
        {
          type: 'storage_warning',
          message:
            'The previous conversation could not be deleted from disk. It may come back after a restart.',
        },
        { type: 'conversation_reset' },
      ])
    })
  })

  it('warns when the conversation cannot be saved', async () => {
    const store = memoryStore()
    store.save = vi.fn(() => Promise.reject(new Error('ENOSPC')))
    const { session, events } = setup(
      scriptedRunner((h) => Promise.resolve([...h, reply('ok')])),
      [],
      store,
    )
    await session.send('Hi')
    await session.idle()
    expect(events).toContainEqual({
      type: 'storage_warning',
      message: 'The conversation could not be saved to disk. It will be lost when the app closes.',
    })
    // The conversation still works in memory.
    expect(session.state().items).toHaveLength(2)
  })

  it('aborts first and still settles every approval when notifications throw', async () => {
    const decisions: boolean[] = []
    const signals: AbortSignal[] = []
    const runner = scriptedRunner(async (history, options) => {
      signals.push(options.signal)
      const ask = () =>
        options.requestApproval({ tool: 'delete_path', kind: 'delete', summary: 'Delete' })
      decisions.push(...(await Promise.all([ask(), ask()])))
      return history
    })
    let broken = false
    const abortedWhenNotified: boolean[] = []
    const { session, prompts } = setup(runner, [], memoryStore(), (event) => {
      if (broken && event.type === 'approval_closed') {
        // The window is gone. Record whether the run was already aborted.
        abortedWhenNotified.push(signals[0]?.aborted === true)
        throw new Error('window destroyed')
      }
    })
    await session.send('Delete both')
    await until(() => prompts.length === 2)
    broken = true
    await session.stop()
    expect(abortedWhenNotified).toEqual([true, true])
    expect(decisions).toEqual([false, false])
    expect(session.pendingApprovals).toEqual([])
    expect(session.running).toBe(false)
  })

  it('denies an approval whose prompt could not be shown', async () => {
    const { runner, decisions } = approvalRunner()
    const store = memoryStore()
    const session = new ChatSession({
      store,
      createRunner: () => Promise.resolve({ ok: true, runner }),
      emit: () => {},
      promptApproval: () => {
        throw new Error('window destroyed')
      },
    })
    await session.send('Write it')
    await session.idle()
    expect(decisions).toEqual([false])
    expect(session.pendingApprovals).toEqual([])
  })
})
