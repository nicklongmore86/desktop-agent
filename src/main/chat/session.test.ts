import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalPrompt, ChatEvent } from '../../shared/ipc'
import { createAgent, type AgentClient, type AgentTool, type RunOptions } from '../agent'
import type { ConversationStore } from '../storage/conversation-store'
import { ChatSession, type AgentRunner, type RunnerResult } from './session'
import { memoryHistory, memoryStore } from './test-support'

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
  const history = memoryHistory(store)
  const session = new ChatSession({
    history,
    createRunner,
    emit: (event) => {
      events.push(event)
      emit?.(event)
    },
    promptApproval: (prompt) => prompts.push(prompt),
    newId: () => `id-${String(++n)}`,
  })
  return { session, events, prompts, store, history, createRunner }
}

const OTHER_CHAT = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
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
    expect(events.filter((event) => event.type !== 'history_changed')).toEqual([
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
    expect(events.filter((e) => e.type !== 'history_changed').slice(1)).toEqual([
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
        origin: 'agent',
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

    it('denies pending approvals on new chat, keeps the old chat and starts empty', async () => {
      const { runner, decisions } = approvalRunner()
      const { session, prompts, events, store, history } = setup(runner, [
        { role: 'user', content: 'old' },
      ])
      await session.init()
      await session.send('Write it')
      await until(() => prompts.length === 1)
      const state = await session.newChat()
      expect(decisions).toEqual([false])
      expect(state).toMatchObject({ items: [], running: false, loadError: null })
      expect(store.clear).not.toHaveBeenCalled()
      // The stopped run is saved to the chat it belongs to, not dropped.
      expect(store.saved().slice(0, 2)).toEqual([
        { role: 'user', content: 'old' },
        { role: 'user', content: 'Write it' },
      ])
      expect(history.setActive).toHaveBeenCalledWith(null)
      expect(events.at(-1)).toMatchObject({ type: 'conversation_reset', state: { items: [] } })
      // Main has forgotten the prompt: a late answer resolves nothing.
      expect(session.respondApproval(prompts[0]?.id, true)).toBe(false)
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
      declined: false,
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
    /** A history whose drafts load only when `finishLoad()` is called. */
    function slowDraftHistory(initial: MessageParam[] = []) {
      const history = memoryHistory(memoryStore(initial))
      const finishes: (() => void)[] = []
      let loading = 0
      let maxConcurrent = 0
      const draft = history.draft
      history.draft = () => {
        const store = draft()
        const loadNow = store.load
        store.load = vi.fn(
          () =>
            new Promise<Awaited<ReturnType<ConversationStore['load']>>>((resolve) => {
              loading += 1
              maxConcurrent = Math.max(maxConcurrent, loading)
              finishes.push(() => {
                loading -= 1
                void loadNow().then(resolve)
              })
            }),
        )
        return store
      }
      return {
        history,
        finishLoad: () => finishes.shift()?.(),
        pendingLoads: () => finishes.length,
        maxConcurrent: () => maxConcurrent,
      }
    }

    function sessionWith(history: ReturnType<typeof memoryHistory>, runner: AgentRunner) {
      const events: ChatEvent[] = []
      const createRunner = vi.fn(() => Promise.resolve<RunnerResult>({ ok: true, runner }))
      const session = new ChatSession({
        history,
        createRunner,
        emit: (event) => events.push(event),
        promptApproval: () => {},
      })
      return { session, events, createRunner }
    }

    it('refuses send while a new chat is opening and resets only once it has loaded', async () => {
      const slow = slowDraftHistory([{ role: 'user', content: 'old' }])
      const { session, events, createRunner } = sessionWith(
        slow.history,
        scriptedRunner((h) => Promise.resolve([...h, reply('ok')])),
      )
      await session.init()
      const reset = session.newChat()
      // Reserved synchronously: a send in the same tick is already refused.
      expect(await session.send('racing')).toEqual({
        ok: false,
        code: 'busy',
        message: 'Chat is busy. Try again in a moment.',
      })
      await until(() => slow.pendingLoads() === 1)
      expect(await session.send('still racing')).toMatchObject({ ok: false, code: 'busy' })
      expect(events.some((e) => e.type === 'conversation_reset')).toBe(false)
      expect(createRunner).not.toHaveBeenCalled()

      slow.finishLoad()
      expect(await reset).toMatchObject({ items: [], running: false, loadError: null })
      expect(events.at(-1)).toMatchObject({ type: 'conversation_reset' })
      expect(await session.send('after')).toEqual({ ok: true })
      await session.idle()
      // The new chat saves to its own draft, never over the old one.
      expect(slow.history.drafts[0]?.saved()[0]).toEqual({ role: 'user', content: 'after' })
    })

    it('runs repeated New chat calls one after another', async () => {
      const slow = slowDraftHistory()
      const { session, events } = sessionWith(
        slow.history,
        scriptedRunner((h) => Promise.resolve(h)),
      )
      const first = session.newChat()
      const second = session.newChat()
      await until(() => slow.pendingLoads() === 1)
      // The second load has not started: the first has not finished.
      expect(slow.history.drafts).toHaveLength(1)
      slow.finishLoad()
      await first
      await until(() => slow.pendingLoads() === 1)
      expect(await session.send('too early')).toMatchObject({ ok: false, code: 'busy' })
      slow.finishLoad()
      await second
      expect(slow.maxConcurrent()).toBe(1)
      expect(events.filter((e) => e.type === 'conversation_reset')).toHaveLength(2)
      expect(await session.send('now')).toEqual({ ok: true })
    })

    it('never lets a run that ignores the abort write into the new chat', async () => {
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
      const { session, store, history } = setup(runner)
      await session.send('Hi')
      const reset = session.newChat()
      finish()
      await reset
      await session.idle()
      // The late answer belongs to the chat it was asked in.
      expect(store.saved()).toEqual([{ role: 'user', content: 'Hi' }, reply('late answer')])
      expect(history.drafts[0]?.saved()).toEqual([])
      expect(session.state().items).toEqual([])
    })

    it('stops a send that is still saving the user message when a new chat starts', async () => {
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
    })
  })

  describe('history', () => {
    it('opens a saved chat with the same protections as a switch', async () => {
      const { runner, decisions } = approvalRunner()
      const { session, prompts, history, events } = setup(runner, [
        { role: 'user', content: 'first chat' },
      ])
      const other = memoryStore([{ role: 'user', content: 'second chat' }])
      history.add('b', other)
      await session.init()
      await session.send('Write it')
      await until(() => prompts.length === 1)
      const opening = session.open('b')
      // Approvals of the chat being left are denied at once, and sends refused.
      expect(session.pendingApprovals).toEqual([])
      expect(session.respondApproval(prompts[0]?.id, true)).toBe(false)
      expect(await session.send('racing')).toMatchObject({ ok: false, code: 'busy' })
      const state = await opening
      expect(decisions).toEqual([false])
      expect(state.items).toEqual([expect.objectContaining({ text: 'second chat' }) as unknown])
      expect(history.setActive).toHaveBeenLastCalledWith('b')
      expect(events.at(-1)).toMatchObject({ type: 'conversation_reset' })
    })

    it('refuses to open an unknown chat and keeps the open one', async () => {
      const { session } = setup(
        scriptedRunner((h) => Promise.resolve(h)),
        [{ role: 'user', content: 'kept' }],
      )
      await session.init()
      await expect(session.open('missing')).rejects.toThrow('no longer exists')
      await expect(session.open(42)).rejects.toThrow('no longer exists')
      expect(session.state().items[0]).toMatchObject({ text: 'kept' })
      expect(await session.send('still works')).toEqual({ ok: true })
    })

    it('starts a new chat before deleting the open one, and warns if deleting fails', async () => {
      const { session, history, events } = setup(scriptedRunner((h) => Promise.resolve(h)))
      const open = memoryStore([{ role: 'user', content: 'doomed' }])
      history.add('a', open)
      history.add('b', memoryStore([{ role: 'user', content: 'other' }]))
      await session.open('a')
      await session.remove('a')
      expect(history.remove).toHaveBeenCalledWith('a')
      expect(session.state().items).toEqual([])
      expect(history.activeId).toBeNull()
      expect(events.at(-1)).toMatchObject({ type: 'history_changed' })

      vi.mocked(history.remove).mockRejectedValueOnce(new Error('EPERM'))
      await session.remove('b')
      expect(events).toContainEqual({
        type: 'storage_warning',
        message: 'The chat could not be deleted from disk. It may come back after a restart.',
      })
    })

    it('deletes another chat without stopping the running reply', async () => {
      let finish: () => void = () => {}
      const runner = scriptedRunner(
        (history) =>
          new Promise((resolve) => {
            finish = () => {
              resolve([...history, reply('done')])
            }
          }),
      )
      const { session, history } = setup(runner)
      history.add('b', memoryStore([{ role: 'user', content: 'other' }]))
      await session.send('Hi')
      await session.remove('b')
      expect(session.running).toBe(true)
      finish()
      await session.idle()
      expect(session.state().items.at(-1)).toMatchObject({ text: 'done' })
    })

    it('renames and announces the new list', async () => {
      const { session, history, events } = setup(scriptedRunner((h) => Promise.resolve(h)))
      history.add('a', memoryStore([{ role: 'user', content: 'x' }]))
      await session.rename('a', 'Plans')
      expect(history.rename).toHaveBeenCalledWith('a', 'Plans')
      expect(events.at(-1)).toMatchObject({ type: 'history_changed' })
    })

    it('announces the list after every save', async () => {
      const { session, events } = setup(scriptedRunner((h) => Promise.resolve([...h, reply('ok')])))
      await session.send('Hi')
      await session.idle()
      expect(events.filter((e) => e.type === 'history_changed')).toHaveLength(2)
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
      history: memoryHistory(store),
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

describe('provider switching', () => {
  it('cancels approvals, saves old history to the old store, and restores the selected history', async () => {
    const runner = scriptedRunner(async (history, options) => {
      await options.requestApproval({ tool: 'write_file', kind: 'write', summary: 'write' })
      options.onEvent({ type: 'text_delta', turn: 1, text: 'stale' })
      return [...history, reply('stopped')]
    })
    const { session, store, events } = setup(runner)
    await session.init()
    await session.send('old provider')
    await until(() => session.pendingApprovals.length === 1)
    const next = memoryStore([{ role: 'user', content: 'other provider' }])
    const commit = vi.fn(() => Promise.resolve())
    const switching = session.switchHistory(memoryHistory(next), commit)
    expect(await session.send('racing send')).toMatchObject({ ok: false, code: 'busy' })
    await switching
    expect(session.pendingApprovals).toEqual([])
    expect(session.state().items[0]).toMatchObject({ text: 'other provider' })
    expect(store.saved()[0]?.content).toBe('old provider')
    expect(next.saved()).toEqual([{ role: 'user', content: 'other provider' }])
    expect(events.some((event) => event.type === 'text_delta' && event.text === 'stale')).toBe(
      false,
    )
    expect(commit).toHaveBeenCalledOnce()
  })
  it("opens a chosen chat of the other provider, denying the old run's approvals first", async () => {
    const runner = scriptedRunner(async (history, options) => {
      await options.requestApproval({ tool: 'write_file', kind: 'write', summary: 'write' })
      return [...history, reply('stopped')]
    })
    const { session, store } = setup(runner)
    await session.init()
    await session.send('old provider')
    await until(() => session.pendingApprovals.length === 1)
    const chosen = memoryStore([{ role: 'user', content: 'the chosen chat' }])
    const other = memoryHistory(memoryStore([{ role: 'user', content: 'its last chat' }]))
    other.add(OTHER_CHAT, chosen)
    const commit = vi.fn(() => Promise.resolve())
    const switching = session.switchHistory(other, commit, OTHER_CHAT)
    expect(session.pendingApprovals).toEqual([])
    await switching
    expect(session.state().items[0]).toMatchObject({ text: 'the chosen chat' })
    expect(commit).toHaveBeenCalledOnce()
    expect(other.setActive).toHaveBeenCalledWith(OTHER_CHAT)
    expect(store.saved()[0]?.content).toBe('old provider')
    // An unknown chat leaves the current one open.
    await expect(session.switchHistory(memoryHistory(), commit, OTHER_CHAT)).rejects.toThrow(
      'That chat no longer exists.',
    )
    expect(session.state().items[0]).toMatchObject({ text: 'the chosen chat' })
  })
  it('never lets a slow initial load overwrite a switch, and refuses sends until loaded', async () => {
    const old = memoryStore()
    let finishLoad: () => void = () => {}
    old.load = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<ConversationStore['load']>>>((resolve) => {
          finishLoad = () => {
            resolve({ messages: [{ role: 'user', content: 'old provider' }], error: null })
          }
        }),
    )
    const { session } = setup(
      scriptedRunner((history) => Promise.resolve(history)),
      [],
      old,
    )
    const loading = session.init()
    expect(await session.send('too early')).toMatchObject({ ok: false, code: 'busy' })
    const switching = session.switchHistory(
      memoryHistory(memoryStore([{ role: 'user', content: 'other provider' }])),
      () => Promise.resolve(),
    )
    await until(() => vi.mocked(old.load).mock.calls.length === 1)
    finishLoad()
    await Promise.all([loading, switching])
    expect(session.state().items).toEqual([
      expect.objectContaining({ text: 'other provider' }) as unknown,
    ])
  })
  it('serializes rapid switches and keeps the previous provider on persistence failure', async () => {
    const { session } = setup(scriptedRunner((history) => Promise.resolve(history)))
    await session.init()
    const order: string[] = []
    const first = session.switchHistory(
      memoryHistory(memoryStore([{ role: 'user', content: 'one' }])),
      () => {
        order.push('one')
        return Promise.resolve()
      },
    )
    const second = session.switchHistory(
      memoryHistory(memoryStore([{ role: 'user', content: 'two' }])),
      () => {
        order.push('two')
        return Promise.resolve()
      },
    )
    await Promise.all([first, second])
    expect(order).toEqual(['one', 'two'])
    expect(session.state().items[0]).toMatchObject({ text: 'two' })
    await expect(
      session.switchHistory(memoryHistory(), () => Promise.reject(new Error('disk full'))),
    ).rejects.toThrow('disk full')
    expect(session.state().items[0]).toMatchObject({ text: 'two' })
  })
})
