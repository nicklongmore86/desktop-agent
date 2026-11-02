import { describe, expect, it } from 'vitest'
import type { ApprovalPrompt, ChatEvent, ChatRef, ChatState, HistoryState } from '../../shared/ipc'
import { chatReducer, initialChatState, type ChatViewState } from './chat-state'

const run = (events: ChatEvent[], state: ChatViewState = initialChatState): ChatViewState =>
  events.reduce((current, event) => chatReducer(current, { type: 'event', event }), state)

const prompt = (id: string, runId = 'r1'): ApprovalPrompt => ({
  id,
  runId,
  toolUseId: null,
  tool: 'write_file',
  kind: 'write',
  summary: 's',
  detail: null,
})

describe('chatReducer', () => {
  it('streams text per turn and attaches tool results to their cards', () => {
    const state = run([
      { type: 'run_started', runId: 'r1', text: 'Hi' },
      { type: 'text_delta', runId: 'r1', turn: 1, text: 'Let me ' },
      { type: 'text_delta', runId: 'r1', turn: 1, text: 'look.' },
      {
        type: 'tool_use',
        runId: 'r1',
        turn: 1,
        id: 't1',
        name: 'list_dir',
        input: { path: 'C:\\' },
      },
      {
        type: 'tool_result',
        runId: 'r1',
        id: 't1',
        content: 'a.txt',
        isError: false,
        declined: false,
      },
      { type: 'text_delta', runId: 'r1', turn: 2, text: 'Found it.' },
    ])
    expect(state.running).toBe(true)
    expect(state.items).toMatchObject([
      { kind: 'user', text: 'Hi' },
      { kind: 'assistant', text: 'Let me look.', turn: 1 },
      { kind: 'tool', id: 't1', result: { content: 'a.txt', isError: false } },
      { kind: 'assistant', text: 'Found it.', turn: 2 },
    ])
  })

  it('rolls back the streamed text of a discarded response only', () => {
    const state = run([
      { type: 'run_started', runId: 'r1', text: 'Hi' },
      { type: 'text_delta', runId: 'r1', turn: 1, text: 'Kept.' },
      { type: 'tool_use', runId: 'r1', turn: 1, id: 't1', name: 'x', input: {} },
      { type: 'text_delta', runId: 'r1', turn: 2, text: 'Truncated…' },
      { type: 'response_discarded', runId: 'r1', turn: 2 },
    ])
    expect(state.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(state.items[1]).toMatchObject({ text: 'Kept.' })
  })

  it('ignores events from a run that is no longer current', () => {
    const state = run([
      { type: 'run_started', runId: 'r1', text: 'Hi' },
      { type: 'run_finished', runId: 'r1', stopReason: 'end_turn' },
      { type: 'text_delta', runId: 'r1', turn: 1, text: 'late' },
      { type: 'error', runId: 'old', code: 'api', message: 'late' },
    ])
    expect(state.items).toHaveLength(1)
    expect(state.banner).toBeNull()
  })

  it('marks a reply stopped mid-stream and shows a neutral notice', () => {
    const state = run([
      { type: 'run_started', runId: 'r1', text: 'Hi' },
      { type: 'text_delta', runId: 'r1', turn: 1, text: 'Partial' },
      { type: 'error', runId: 'r1', code: 'aborted', message: 'Agent run cancelled.' },
      { type: 'run_finished', runId: 'r1', stopReason: 'aborted' },
    ])
    expect(state.items[1]).toMatchObject({ kind: 'assistant', stopped: true })
    expect(state.banner).toMatchObject({ code: 'aborted' })
    expect(state.running).toBe(false)
  })

  it('queues approvals, closes them by id, and drops a finished run’s prompts', () => {
    let state = run([{ type: 'run_started', runId: 'r1', text: 'Hi' }])
    state = chatReducer(state, { type: 'approval', prompt: prompt('a') })
    state = chatReducer(state, { type: 'approval', prompt: prompt('a') })
    state = chatReducer(state, { type: 'approval', prompt: prompt('b') })
    expect(state.approvals.map((p) => p.id)).toEqual(['a', 'b'])
    state = run([{ type: 'approval_closed', approvalId: 'a', approved: false }], state)
    expect(state.approvals.map((p) => p.id)).toEqual(['b'])
    state = run([{ type: 'run_finished', runId: 'r1', stopReason: 'aborted' }], state)
    expect(state.approvals).toEqual([])
  })

  it('clears everything on conversation_reset', () => {
    const state = run([
      { type: 'run_started', runId: 'r1', text: 'Hi' },
      { type: 'error', runId: 'r1', code: 'rate_limit', message: 'Slow down' },
      { type: 'conversation_reset' },
    ])
    expect(state).toEqual(initialChatState)
  })

  describe('chat switch (another chat or New chat)', () => {
    const old: ChatViewState = {
      ...run([
        { type: 'run_started', runId: 'r1', text: 'Old question' },
        { type: 'text_delta', runId: 'r1', turn: 1, text: 'Old answer' },
      ]),
      approvals: [prompt('a1')],
      storageWarning: 'disk full',
    }
    const switching = chatReducer(old, { type: 'switch_started' })
    const fresh = {
      items: [{ kind: 'user' as const, id: 'n', text: 'New' }],
      running: false,
      loadError: null,
    }

    it('clears the old conversation and approvals as soon as it starts', () => {
      expect(switching).toEqual({
        ...initialChatState,
        storageWarning: 'disk full',
        switching: true,
        switchKind: 'chat',
      })
    })

    it('ignores the old provider’s events, prompts, loads and New chat resets meanwhile', () => {
      let state = run(
        [
          { type: 'text_delta', runId: 'r1', turn: 1, text: 'more' },
          { type: 'run_started', runId: 'r2', text: 'late' },
          { type: 'text_delta', runId: 'r2', turn: 1, text: 'late reply' },
          { type: 'tool_use', runId: 'r1', turn: 1, id: 't', name: 'x', input: {} },
          { type: 'run_finished', runId: 'r1', stopReason: 'aborted' },
          { type: 'conversation_reset' },
        ],
        switching,
      )
      state = chatReducer(state, { type: 'approval', prompt: prompt('a2') })
      state = chatReducer(state, {
        type: 'loaded',
        state: { items: old.items, running: true, loadError: null },
      })
      expect(state).toEqual(switching)
    })

    it('ends with the new provider’s history from the reset', () => {
      const state = run([{ type: 'conversation_reset', state: fresh }], switching)
      expect(state.switching).toBe(false)
      expect(state.items).toEqual(fresh.items)
      // provider.set settles after the reset: its follow-up load is not applied again.
      expect(chatReducer(state, { type: 'switch_finished', state: { ...fresh, items: [] } })).toBe(
        state,
      )
    })

    it('falls back to main’s current conversation when no reset came', () => {
      expect(chatReducer(switching, { type: 'switch_finished', state: fresh })).toMatchObject({
        switching: false,
        items: fresh.items,
      })
      expect(chatReducer(switching, { type: 'switch_finished', state: null })).toMatchObject({
        switching: false,
        items: [],
        banner: { code: 'internal' },
      })
    })
  })

  describe('connection switch (the open chat continues on another connection)', () => {
    const A = { provider: 'claude', id: 'chat-a' }
    const B = { provider: 'codex-subscription', id: 'chat-b' }
    const listOf = (active: ChatRef | null): HistoryState => ({
      conversations: [],
      activeId: active?.id ?? null,
      active,
      chats: [
        { ...{ id: A.id, title: 'A', createdAt: 1, updatedAt: 2 }, provider: A.provider },
        { ...{ id: B.id, title: 'B', createdAt: 1, updatedAt: 1 }, provider: B.provider },
      ],
    })
    const stateFor = (items: ChatState['items'], active: ChatRef | null): ChatState => ({
      items,
      running: false,
      loadError: null,
      history: listOf(active),
    })
    const open = chatReducer(
      chatReducer(initialChatState, {
        type: 'loaded',
        state: stateFor([{ kind: 'user', id: 'u', text: 'Hello' }], A),
      }),
      { type: 'event', event: { type: 'run_started', runId: 'r1', text: 'More' } },
    )
    const withApproval = chatReducer(
      chatReducer(open, {
        type: 'event',
        event: { type: 'text_delta', runId: 'r1', turn: 1, text: 'Partial' },
      }),
      { type: 'approval', prompt: prompt('a1') },
    )
    const switching = chatReducer(withApproval, {
      type: 'switch_started',
      kind: 'connection',
      to: 'codex-subscription',
    })

    it('keeps the messages and the list, stops the run view and drops approvals', () => {
      expect(switching).toMatchObject({
        switching: true,
        switchKind: 'connection',
        switchTo: 'codex-subscription',
        switchChat: A,
        running: false,
        runId: null,
        approvals: [],
        history: withApproval.history,
      })
      expect(switching.items).toEqual(withApproval.items)
    })

    it('ignores the old run, prompts and loads until the same chat is reset', () => {
      let state = run(
        [
          { type: 'text_delta', runId: 'r1', turn: 1, text: 'more' },
          { type: 'run_started', runId: 'r2', text: 'late' },
          { type: 'run_finished', runId: 'r1', stopReason: 'aborted' },
        ],
        switching,
      )
      state = chatReducer(state, { type: 'approval', prompt: prompt('a2') })
      state = chatReducer(state, { type: 'loaded', state: stateFor([], A) })
      expect(state).toEqual(switching)
    })

    it('keeps the list live: history_changed arriving mid-switch is applied', () => {
      const renamed = listOf(A)
      renamed.chats = (renamed.chats ?? []).map((c) => ({ ...c, title: `${c.title}!` }))
      const state = run([{ type: 'history_changed', history: renamed }], switching)
      expect(state.history).toBe(renamed)
      expect(state.switching).toBe(true)
      expect(state.items).toEqual(switching.items)
      expect(chatReducer(switching, { type: 'history', history: renamed }).history).toBe(renamed)
    })

    it('ends with the reset of the same chat, which replaces the messages', () => {
      const saved = stateFor(
        [
          { kind: 'user', id: 'u', text: 'Hello' },
          { kind: 'assistant', id: 'a', text: 'Hi', connection: 'codex-subscription' },
        ],
        A,
      )
      const state = run([{ type: 'conversation_reset', state: saved }], switching)
      expect(state).toMatchObject({
        switching: false,
        switchKind: null,
        switchTo: null,
        switchChat: null,
      })
      expect(state.items).toEqual(saved.items)
      // provider.set settles afterwards: its follow-up load is not applied again.
      expect(chatReducer(state, { type: 'switch_finished', state: stateFor([], A) })).toBe(state)
    })

    it('does not take a reset for another chat as its own', () => {
      const other = stateFor([{ kind: 'user', id: 'x', text: 'Other chat' }], B)
      expect(run([{ type: 'conversation_reset', state: other }], switching)).toBe(switching)
      expect(run([{ type: 'conversation_reset' }], switching)).toBe(switching)
    })

    it('matches a new, unsaved chat by null', () => {
      const fresh = chatReducer(initialChatState, { type: 'loaded', state: stateFor([], null) })
      const waiting = chatReducer(fresh, { type: 'switch_started', kind: 'connection' })
      expect(waiting.switchChat).toBeNull()
      const done = run([{ type: 'conversation_reset', state: stateFor([], null) }], waiting)
      expect(done.switching).toBe(false)
      expect(run([{ type: 'conversation_reset', state: stateFor([], A) }], waiting)).toBe(waiting)
    })

    it('restores cleanly when the switch fails: main’s chat comes back, or the messages stay with a banner', () => {
      const main = stateFor([{ kind: 'user', id: 'u', text: 'Hello' }], A)
      expect(chatReducer(switching, { type: 'switch_finished', state: main })).toMatchObject({
        switching: false,
        switchKind: null,
        switchChat: null,
        items: main.items,
        approvals: [],
      })
      const unreadable = chatReducer(switching, { type: 'switch_finished', state: null })
      expect(unreadable).toMatchObject({
        switching: false,
        switchKind: null,
        banner: { code: 'internal' },
      })
      expect(unreadable.items).toEqual(switching.items)
    })

    it('still shows storage warnings and closes approvals during the switch', () => {
      const state = run([{ type: 'storage_warning', message: 'disk full' }], switching)
      expect(state.storageWarning).toBe('disk full')
      expect(state.switching).toBe(true)
    })

    it('a chat opened during the switch is ignored by it, and the switch’s own reset still ends it', () => {
      // Opening is disabled while switching; a late reset for the chat opened from before is dropped.
      const stale = stateFor([{ kind: 'user', id: 'x', text: 'Stale' }], B)
      const mid = run([{ type: 'conversation_reset', state: stale }], switching)
      expect(mid).toBe(switching)
      const done = run([{ type: 'conversation_reset', state: stateFor([], A) }], mid)
      expect(done.switching).toBe(false)
    })
  })
})
