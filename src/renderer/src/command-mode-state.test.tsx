import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatEvent } from '../../shared/ipc'
import { chatReducer, initialChatState, type ChatViewState } from './chat-state'
import { useChatView } from './use-chat-view'

const run = (events: ChatEvent[], state: ChatViewState = initialChatState): ChatViewState =>
  events.reduce((current, event) => chatReducer(current, { type: 'event', event }), state)

afterEach(() => {
  localStorage.clear()
})

describe('chatReducer: commands from the command bar', () => {
  it('adds a running card, attaches the result, and ends like a run', () => {
    const started = run([
      { type: 'command_started', runId: 'r1', id: 'c1', command: 'dir', cwd: 'C:\\work' },
    ])
    expect(started).toMatchObject({ running: true, runId: 'r1' })
    expect(started.items).toEqual([
      {
        kind: 'tool',
        id: 'c1',
        name: 'run_shell',
        input: { command: 'dir', cwd: 'C:\\work' },
        result: null,
        origin: 'user-terminal',
      },
    ])
    const done = run(
      [
        { type: 'tool_result', runId: 'r1', id: 'c1', content: 'exit code: 0', isError: false },
        { type: 'run_finished', runId: 'r1', stopReason: 'end_turn' },
      ],
      started,
    )
    expect(done).toMatchObject({ running: false, runId: null })
    expect(done.items[0]).toMatchObject({ result: { content: 'exit code: 0', isError: false } })
  })

  it('ignores a command started during a switch', () => {
    const switching = chatReducer(initialChatState, { type: 'switch_started', kind: 'chat' })
    const state = run(
      [{ type: 'command_started', runId: 'r1', id: 'c1', command: 'dir', cwd: 'C:\\work' }],
      switching,
    )
    expect(state.items).toEqual([])
    expect(state.running).toBe(false)
  })
})

describe('useChatView', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  it('keeps Command for a new chat once its first command saves it', () => {
    const hook = renderHook(({ id, switching }) => useChatView(id, switching), {
      initialProps: { id: null as string | null, switching: false },
    })
    act(() => {
      hook.result.current[1]('command')
    })
    hook.rerender({ id: A, switching: false })
    expect(hook.result.current[0]).toBe('command')
    expect(JSON.parse(localStorage.getItem('desktop-agent.chat-views') ?? '{}')).toEqual({
      [A]: 'command',
    })
  })

  it('does not carry the new chat’s view to a chat opened from it', () => {
    const hook = renderHook(({ id, switching }) => useChatView(id, switching), {
      initialProps: { id: null as string | null, switching: false },
    })
    act(() => {
      hook.result.current[1]('command')
    })
    hook.rerender({ id: null, switching: true })
    hook.rerender({ id: B, switching: false })
    expect(hook.result.current[0]).toBe('chat')
  })

  it('reads remembered views and survives unreadable storage', () => {
    localStorage.setItem('desktop-agent.chat-views', JSON.stringify({ [A]: 'command', [B]: 'x' }))
    expect(renderHook(() => useChatView(A, false)).result.current[0]).toBe('command')
    expect(renderHook(() => useChatView(B, false)).result.current[0]).toBe('chat')
    localStorage.setItem('desktop-agent.chat-views', '{not json')
    expect(renderHook(() => useChatView(A, false)).result.current[0]).toBe('chat')
  })
})
