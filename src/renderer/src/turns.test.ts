import { describe, expect, it } from 'vitest'
import type { ViewItem } from './chat-state'
import {
  activePromptIndex,
  formatDuration,
  plainLabel,
  splitTurns,
  stepPrompt,
  workSpan,
} from './turns'

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [850, '850ms'],
    [1234, '1.2s'],
    [9999, '9.9s'],
    [12_000, '12s'],
    [65_000, '1m 5s'],
    [3_720_000, '1h 2m'],
    [-5, '0ms'],
  ])('%i ms is %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
})

describe('activePromptIndex', () => {
  it('picks the last prompt that starts at or above the midpoint', () => {
    expect(activePromptIndex([-300, 100, 500], 200)).toBe(1)
    expect(activePromptIndex([-300, 100, 500], 600)).toBe(2)
    expect(activePromptIndex([300, 500], 200)).toBe(0)
    expect(activePromptIndex([], 0)).toBe(0)
  })
})

describe('stepPrompt', () => {
  it('moves by one and stops at the ends', () => {
    expect(stepPrompt(1, 3, -1)).toBe(0)
    expect(stepPrompt(1, 3, 1)).toBe(2)
    expect(stepPrompt(0, 3, -1)).toBeNull()
    expect(stepPrompt(2, 3, 1)).toBeNull()
  })
})

describe('plainLabel', () => {
  it('collapses whitespace, drops control and bidi characters and truncates', () => {
    expect(plainLabel('a\n\n  b‮c\u0007d', 80)).toBe('a b c d')
    expect(plainLabel('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

const tool = (id: string, startedAt?: number, endedAt?: number): ViewItem => ({
  kind: 'tool',
  id,
  name: 'list_dir',
  input: {},
  result: endedAt === undefined ? null : { content: '', isError: false },
  ...(startedAt === undefined ? {} : { startedAt }),
  ...(endedAt === undefined ? {} : { endedAt }),
})

describe('splitTurns', () => {
  it('starts a turn at each prompt and groups consecutive tools', () => {
    const turns = splitTurns([
      { kind: 'user', id: 'u1', text: 'one' },
      tool('a'),
      tool('b'),
      { kind: 'assistant', id: 'x1', text: 'reply' },
      { kind: 'user', id: 'u2', text: 'two' },
      { kind: 'assistant', id: 'x2', text: 'reply' },
    ])
    expect(turns.map((turn) => turn.user?.id)).toEqual(['u1', 'u2'])
    expect(turns[0]?.entries.map((entry) => entry.kind)).toEqual(['tools', 'item'])
    expect(turns[1]?.entries).toHaveLength(1)
  })
})

describe('workSpan', () => {
  it('runs from the first call to the last result', () => {
    const tools = [tool('a', 1000, 2000), tool('b', 1500, 6000)].filter((i) => i.kind === 'tool')
    expect(workSpan(tools)).toBe(5000)
  })
  it('is unknown without timestamps', () => {
    expect(workSpan([tool('a')].filter((i) => i.kind === 'tool'))).toBeNull()
  })
})
