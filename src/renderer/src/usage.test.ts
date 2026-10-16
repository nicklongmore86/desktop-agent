import { describe, expect, it } from 'vitest'
import type { ProviderAllowance } from '../../shared/ipc'
import { describeFailure, formatReset, summarizeUsage, usageLevel, windowName } from './usage'

const allowance = (overrides: Partial<ProviderAllowance> = {}): ProviderAllowance => ({
  provider: 'codex-subscription',
  plan: 'Plus',
  state: 'available',
  resetsAt: null,
  windows: [],
  lastError: null,
  ...overrides,
})
const window = (limitId: string, remainingPercent: number) => ({
  limitId,
  remainingPercent,
  resetsAt: null,
})

describe('usageLevel', () => {
  it('is none for unknown allowance', () => {
    expect(usageLevel(null)).toBe('none')
    expect(usageLevel(allowance({ plan: null, state: 'unknown' }))).toBe('none')
  })

  it('is ok below 80% used and warning from 80%', () => {
    expect(usageLevel(allowance({ windows: [window('codex:primary', 21)] }))).toBe('ok')
    expect(usageLevel(allowance({ windows: [window('codex:primary', 20)] }))).toBe('warning')
    expect(
      usageLevel(
        allowance({ windows: [window('codex:primary', 90), window('codex:secondary', 5)] }),
      ),
    ).toBe('warning')
  })

  it('is limited when the provider says so, whatever the windows show', () => {
    expect(
      usageLevel(allowance({ state: 'limited', windows: [window('codex:primary', 90)] })),
    ).toBe('limited')
  })

  it('is ok for Claude with just a plan, and shows no percentage', () => {
    const claude = allowance({ provider: 'claude-subscription', plan: 'Pro' })
    expect(usageLevel(claude)).toBe('ok')
    expect(summarizeUsage(claude)).toEqual({ level: 'ok', text: 'Pro', detail: 'Pro plan' })
  })
})

describe('formatReset', () => {
  const now = new Date(2026, 9, 16, 12, 0)

  it('is null for missing or invalid timestamps', () => {
    expect(formatReset(null, now)).toBeNull()
    expect(formatReset('nope', now)).toBeNull()
  })

  it('shows only the time for today', () => {
    const text = formatReset(new Date(2026, 9, 16, 15, 45).toISOString(), now)
    expect(text).toBe(
      new Date(2026, 9, 16, 15, 45).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    )
  })

  it('includes the date on another day', () => {
    const later = new Date(2026, 9, 18, 9, 5)
    const text = formatReset(later.toISOString(), now)
    expect(text).toContain(later.toLocaleDateString([], { month: 'short', day: 'numeric' }))
    expect(text).toContain(later.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
  })
})

describe('summarizeUsage', () => {
  const now = new Date(2026, 9, 16, 12, 0)

  it('words a warning like "82% of weekly limit used"', () => {
    expect(
      summarizeUsage(
        allowance({ windows: [{ ...window('codex:secondary', 18), label: 'weekly limit' }] }),
        now,
      ),
    ).toMatchObject({ level: 'warning', text: '82% of weekly limit used' })
  })

  it('words a limit with its reset', () => {
    const reset = new Date(2026, 9, 18, 9, 5)
    const summary = summarizeUsage(
      allowance({ state: 'limited', resetsAt: reset.toISOString() }),
      now,
    )
    expect(summary?.level).toBe('limited')
    expect(summary?.text).toMatch(/^Limit reached – resets .+/)
    expect(summarizeUsage(allowance({ state: 'limited' }), now)?.text).toBe('Limit reached')
  })
})

describe('windowName', () => {
  it('uses the label from the runtime, never the limit id', () => {
    expect(windowName({ label: 'weekly limit' })).toBe('weekly limit')
    expect(windowName({})).toBe('usage limit')
  })
})

describe('describeFailure', () => {
  it('words the typed reasons and leaves unknown ones to the caller', () => {
    expect(describeFailure({ code: 'auth_expired', message: 'x' })).toBe(
      'Sign-in expired — sign in again',
    )
    expect(describeFailure({ code: 'usage_limit', message: 'x' })).toBe('Limit reached')
    expect(
      describeFailure({ code: 'usage_limit', message: 'x', resetsAt: '2027-01-15T08:00:00Z' }),
    ).toMatch(/^Limit reached — resets /)
    expect(describeFailure({ code: 'runtime_unavailable', message: 'x' })).toMatch(/unavailable/)
    expect(describeFailure({ code: 'model_unavailable', message: 'x' })).toMatch(/not available/)
    expect(describeFailure({ code: 'internal', message: 'x' })).toBeNull()
    expect(describeFailure(null)).toBeNull()
  })
})
