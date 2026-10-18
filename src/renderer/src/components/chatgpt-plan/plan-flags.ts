import { useCallback, useState } from 'react'

/** The per-connection "has seen the plan notice" flag. Never cleared, so Remove keeps it. */
export const planNoticeKey = (connection: string): string => `plan-notice-seen:${connection}`
/** The Codex users' "you can use your plan directly" banner was dismissed. */
export const SWITCH_BANNER_KEY = 'plan-switch-banner-dismissed'

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/**
 * A one-time flag kept in localStorage: a convenience, not a record. Without storage the
 * flag still holds for this run, and the notice may return on the next launch.
 */
export function useFlag(key: string): [boolean, () => void] {
  const [state, setState] = useState(() => ({ key, set: read(key) }))
  // A different key (another connection) reads its own flag.
  if (state.key !== key) setState({ key, set: read(key) })
  const mark = useCallback(() => {
    setState({ key, set: true })
    try {
      localStorage.setItem(key, '1')
    } catch {
      // Not saved: it only comes back next launch.
    }
  }, [key])
  return [state.key === key ? state.set : read(key), mark]
}
