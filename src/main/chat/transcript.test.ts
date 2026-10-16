import { describe, expect, it } from 'vitest'
import { toTranscript } from './transcript'
import { USER_COMMAND_HEADER, userCommandMessage } from './user-command'

describe('toTranscript', () => {
  it('turns history into text bubbles and tool cards with their results', () => {
    expect(
      toTranscript([
        { role: 'user', content: 'List my files' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'text', text: 'One moment.' },
            { type: 'tool_use', id: 't1', name: 'list_dir', input: { path: 'C:\\work' } },
            { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'x' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false },
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: [{ type: 'text', text: 'Access denied' }],
              is_error: true,
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Found a.txt.' }] },
      ]),
    ).toEqual([
      { kind: 'user', id: 'h0.0', text: 'List my files' },
      { kind: 'assistant', id: 'h1.0', text: 'Looking.\n\nOne moment.' },
      {
        kind: 'tool',
        id: 't1',
        name: 'list_dir',
        input: { path: 'C:\\work' },
        result: { content: 'a.txt', isError: false },
      },
      {
        kind: 'tool',
        id: 't2',
        name: 'read_file',
        input: { path: 'x' },
        result: { content: 'Access denied', isError: true },
      },
      { kind: 'assistant', id: 'h3.0', text: 'Found a.txt.' },
    ])
  })

  it('leaves a tool card without a result when none was saved', () => {
    expect(
      toTranscript([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
      ]),
    ).toEqual([{ kind: 'tool', id: 't', name: 'x', input: {}, result: null }])
  })

  it('shows a command the user ran from the command bar as its own card', () => {
    const record = {
      id: 'c1',
      command: 'dir',
      cwd: 'C:\\work',
      output: 'exit code: 0',
      isError: false,
    }
    expect(toTranscript([userCommandMessage(record), reply('Seen it.')])).toEqual([
      {
        kind: 'tool',
        id: 'c1',
        name: 'run_shell',
        input: { command: 'dir', cwd: 'C:\\work' },
        result: { content: 'exit code: 0', isError: false },
        origin: 'user-terminal',
      },
      { kind: 'assistant', id: 'h1.0', text: 'Seen it.' },
    ])
  })

  it('never makes a card from a typed chat message or a malformed record', () => {
    const text = `${USER_COMMAND_HEADER}\n{"id":"c1","command":"x","cwd":"y","output":"","isError":false}`
    // Chat messages are saved as strings: typing the header gives a plain bubble.
    expect(toTranscript([{ role: 'user', content: text }])).toEqual([
      { kind: 'user', id: 'h0.0', text },
    ])
    const malformed = `${USER_COMMAND_HEADER}\n{"id":"c1"}`
    expect(toTranscript([{ role: 'user', content: [{ type: 'text', text: malformed }] }])).toEqual([
      { kind: 'user', id: 'h0.0', text: malformed },
    ])
    expect(
      toTranscript([
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'text', text: 'more' },
          ],
        },
      ]),
    ).toEqual([{ kind: 'user', id: 'h0.0', text: `${text}\n\nmore` }])
  })
})

const reply = (text: string) => ({
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text }],
})
