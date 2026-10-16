import { useCallback, useEffect, useState } from 'react'
import type {
  AllowanceWindow,
  ProviderAllowance,
  ProviderFailure,
  ProviderId,
} from '../../shared/ipc'
import { useApi } from './api'

/** At or above this share of any window used, the indicator turns amber. */
export const USAGE_WARNING_PERCENT = 80

/** none: nothing worth showing. ok: low usage (subtle). warning: nearly used up. limited: blocked. */
export type UsageLevel = 'none' | 'ok' | 'warning' | 'limited'

export interface UsageSummary {
  level: UsageLevel
  /** Short text for the indicator. */
  text: string
  /** Longer text for a tooltip and screen readers. */
  detail: string
}

export const usedPercent = (remainingPercent: number): number =>
  Math.min(100, Math.max(0, Math.round(100 - remainingPercent)))

/** The user-facing name of a rate-limit window. */
export const windowName = (window: Pick<AllowanceWindow, 'label'>): string =>
  window.label ?? 'usage limit'

/** The window with the most usage, or null when the provider reports none (Claude). */
function busiestWindow(allowance: ProviderAllowance): { used: number; name: string } | null {
  let best: { used: number; name: string } | null = null
  for (const window of allowance.windows) {
    const used = usedPercent(window.remainingPercent)
    if (!best || used > best.used) {
      best = { used, name: windowName(window) }
    }
  }
  return best
}

/** How concerned to be about an allowance. Advisory only: it never blocks sending. */
export function usageLevel(allowance: ProviderAllowance | null | undefined): UsageLevel {
  if (!allowance) return 'none'
  if (allowance.state === 'limited') return 'limited'
  const busiest = busiestWindow(allowance)
  if (busiest && busiest.used >= USAGE_WARNING_PERCENT) return 'warning'
  if (busiest || allowance.plan) return 'ok'
  return 'none'
}

/**
 * When a limit resets: the time today, or the date and time on another day.
 * Null for a missing or invalid timestamp.
 */
export function formatReset(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  if (sameDay) return time
  return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/** What to show for an allowance, or null for nothing at all. */
export function summarizeUsage(
  allowance: ProviderAllowance | null | undefined,
  now: Date = new Date(),
): UsageSummary | null {
  const level = usageLevel(allowance)
  if (!allowance || level === 'none') return null
  const plan = allowance.plan ? `${allowance.plan} plan` : 'Plan'
  if (level === 'limited') {
    const reset = formatReset(allowance.resetsAt, now)
    const text = reset ? `Limit reached – resets ${reset}` : 'Limit reached'
    return { level, text, detail: `${plan}: ${text}` }
  }
  const busiest = busiestWindow(allowance)
  if (!busiest) return { level, text: allowance.plan ?? '', detail: plan }
  const text = `${String(busiest.used)}% of ${busiest.name} used`
  return { level, text, detail: `${plan}: ${text}` }
}

/**
 * Specific text for a typed provider failure, or null for codes without one
 * (callers keep their generic text).
 */
export function describeFailure(
  failure: ProviderFailure | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!failure) return null
  switch (failure.code) {
    case 'auth_expired':
      return 'Sign-in expired — sign in again'
    case 'usage_limit': {
      const reset = formatReset(failure.resetsAt, now)
      return reset ? `Limit reached — resets ${reset}` : 'Limit reached'
    }
    case 'runtime_unavailable':
      return 'The provider runtime is unavailable right now'
    case 'model_unavailable':
      return 'That model is not available for this account'
    default:
      return null
  }
}

interface Loaded {
  provider: ProviderId
  allowance: ProviderAllowance | null
  failure: ProviderFailure | null
}

export interface ProviderUsage {
  /** The allowance of `provider`; null while unknown, unreadable or from another provider. */
  allowance: ProviderAllowance | null
  /** Why the allowance could not be read, when the provider gave a typed reason. */
  failure: ProviderFailure | null
  /** Reads it again. Safe to call at any time; stale answers are ignored. */
  refresh: () => void
}

/**
 * The selected provider's allowance, read when the provider changes and whenever
 * `refresh` is called (after a turn, or a usage-limit error). Never polls.
 * It is advisory: nothing here gates sending.
 */
export function useProviderUsage(provider: ProviderId | undefined): ProviderUsage {
  const api = useApi()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!provider) return
    let current = true
    const read = async (): Promise<void> => {
      let next: ProviderAllowance | null = null
      let failure: ProviderFailure | null = null
      try {
        const result = await api.provider.allowance()
        if (result.ok) {
          if (result.value.provider === provider) next = result.value
        } else {
          failure = result.failure
        }
        if (!result.ok && result.failure.code === 'usage_limit') {
          next = {
            provider,
            plan: null,
            state: 'limited',
            resetsAt: result.failure.resetsAt ?? null,
            windows: [],
            lastError: result.failure,
          }
        }
      } catch {
        // Unknown allowance is shown as nothing.
      }
      if (current) setLoaded({ provider, allowance: next, failure })
    }
    void read()
    return () => {
      current = false
    }
  }, [api, provider, tick])

  const refresh = useCallback(() => {
    setTick((value) => value + 1)
  }, [])

  const own = loaded && loaded.provider === provider ? loaded : null
  return { allowance: own?.allowance ?? null, failure: own?.failure ?? null, refresh }
}
