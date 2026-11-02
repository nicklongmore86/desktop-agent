import { describe, expect, it } from 'vitest'
import { badgedReplies, type ReplyOrigin } from './provenance'

const reply = (id: string, origin?: ReplyOrigin) => ({ id, origin })
const badged = (replies: ReturnType<typeof reply>[]): string[] => [
  ...badgedReplies(replies, (r) => r.origin).keys(),
]

describe('badgedReplies', () => {
  it('badges the first reply, then only where the connection changes', () => {
    expect(
      badged([
        reply('1', { connection: 'claude-subscription', model: 'opus' }),
        reply('2', { connection: 'claude-subscription', model: 'opus' }),
        reply('3', { connection: 'codex-subscription', model: 'gpt' }),
        reply('4', { connection: 'codex-subscription', model: 'gpt' }),
        reply('5', { connection: 'claude-subscription', model: 'opus' }),
      ]),
    ).toEqual(['1', '3', '5'])
  })

  it('badges a model change on the same connection', () => {
    expect(
      badged([
        reply('1', { connection: 'codex-subscription', model: 'a' }),
        reply('2', { connection: 'codex-subscription', model: 'b' }),
        reply('3', { connection: 'codex-subscription', model: 'b' }),
      ]),
    ).toEqual(['1', '2'])
  })

  it('does not count an unknown model as a change, and remembers the last known one', () => {
    expect(
      badged([
        reply('1', { connection: 'codex-subscription', model: 'a' }),
        reply('2', { connection: 'codex-subscription' }),
        reply('3', { connection: 'codex-subscription', model: 'a' }),
        reply('4', { connection: 'claude-subscription' }),
        reply('5', { connection: 'codex-subscription', model: 'a' }),
      ]),
    ).toEqual(['1', '4', '5'])
  })

  it('skips replies with no recorded origin without moving the comparison', () => {
    expect(
      badged([
        reply('old'),
        reply('1', { connection: 'claude-subscription' }),
        reply('older'),
        reply('2', { connection: 'claude-subscription' }),
      ]),
    ).toEqual(['1'])
    expect(badged([])).toEqual([])
  })
})
