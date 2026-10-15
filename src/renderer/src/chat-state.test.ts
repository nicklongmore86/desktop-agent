import { describe, expect, it } from 'vitest'
import type { ApprovalPrompt, ChatEvent } from '../../shared/ipc'
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
      { type: 'tool_result', runId: 'r1', id: 't1', content: 'a.txt', isError: false },
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

  describe('provider switch', () => {
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
})
