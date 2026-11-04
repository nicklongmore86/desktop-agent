import { describe, expect, it } from 'vitest'
import type { ChatEvent } from '../shared/ipc'
import { AttentionTracker, NOTIFICATION_TEXT, shouldAlert } from './attention'

const finished = (runId: string, stopReason = 'end_turn'): ChatEvent => ({
  type: 'run_finished',
  runId,
  stopReason,
})
const failed = (runId: string, code: 'network' | 'api' = 'network'): ChatEvent => ({
  type: 'error',
  runId,
  code,
  message: 'Could not reach the model.',
})

describe('AttentionTracker', () => {
  it('alerts once when a reply finishes', () => {
    const tracker = new AttentionTracker()
    expect(tracker.onChatEvent(finished('r1'))).toBe('reply-ready')
    expect(tracker.onChatEvent(finished('r1'))).toBe('reply-ready') // a different run id is a different reply
  })

  it('alerts once for a failure: the error, then its run_finished, gives one alert', () => {
    const tracker = new AttentionTracker()
    expect(tracker.onChatEvent(failed('r1'))).toBe('reply-failed')
    expect(tracker.onChatEvent(finished('r1', 'network'))).toBeNull()
  })

  it('alerts for a failure that only shows in the stop reason', () => {
    const tracker = new AttentionTracker()
    expect(tracker.onChatEvent(finished('r1', 'internal'))).toBe('reply-failed')
    expect(tracker.onChatEvent(finished('r2', 'rate_limit'))).toBe('reply-failed')
  })

  it('stays quiet for a run the user stopped', () => {
    expect(new AttentionTracker().onChatEvent(finished('r1', 'aborted'))).toBeNull()
  })

  it('stays quiet for a typed command, however it ends', () => {
    const tracker = new AttentionTracker()
    tracker.onChatEvent({
      type: 'command_started',
      runId: 'c1',
      id: 'x',
      command: 'dir',
      cwd: 'C:\\',
    })
    expect(tracker.onChatEvent(finished('c1', 'error'))).toBeNull()
    // And the id is forgotten: a later reply with the same id would alert.
    expect(tracker.onChatEvent(finished('c1'))).toBe('reply-ready')
  })

  it('alerts for an approval once, until it closes', () => {
    const tracker = new AttentionTracker()
    expect(tracker.onApproval({ id: 'a1' })).toBe('approval')
    expect(tracker.onApproval({ id: 'a1' })).toBeNull()
    expect(tracker.onApproval({ id: 'a2' })).toBe('approval')
    tracker.onChatEvent({ type: 'approval_closed', approvalId: 'a1', approved: false })
    // A new prompt with a new id is a new approval; the same id after it closed is too.
    expect(tracker.onApproval({ id: 'a1' })).toBe('approval')
  })

  it('ignores every other event', () => {
    const tracker = new AttentionTracker()
    expect(
      tracker.onChatEvent({ type: 'text_delta', runId: 'r', turn: 1, text: 'hello' }),
    ).toBeNull()
    expect(tracker.onChatEvent({ type: 'run_started', runId: 'r', text: 'hi' })).toBeNull()
  })
})

describe('NOTIFICATION_TEXT', () => {
  it('is short fixed app text for every alert', () => {
    for (const text of Object.values(NOTIFICATION_TEXT)) {
      expect(text.title).toBe('Desktop Agent')
      expect(text.body.length).toBeLessThan(60)
      // Nothing that could be filled in from user content.
      expect(text.body).not.toMatch(/[{}$\\/:<>]/)
    }
  })
})

describe('shouldAlert', () => {
  it('needs notifications on and the window not in front', () => {
    expect(shouldAlert({ enabled: true, windowFocused: false })).toBe(true)
    expect(shouldAlert({ enabled: true, windowFocused: true })).toBe(false)
    expect(shouldAlert({ enabled: false, windowFocused: false })).toBe(false)
    expect(shouldAlert({ enabled: false, windowFocused: true })).toBe(false)
  })
})
