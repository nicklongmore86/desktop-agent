import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { THEMES, type ThemePreference } from '../../shared/ipc'
import { useApi } from './api'

/**
 * The colour theme: System, Light or Dark.
 *
 * The saved choice lives in main (settings.json). It is also cached in
 * localStorage so public/theme-init.js can apply it before first paint, which
 * avoids a flash of the wrong theme on start-up. Light and dark are applied as
 * `data-theme` on <html>; System removes the attribute, so the stylesheet
 * follows `prefers-color-scheme` (see styles/tokens.css).
 *
 * Settings wires it with `const { theme, setTheme } = useTheme()`.
 */

/** Keep in sync with public/theme-init.js. */
const CACHE_KEY = 'desktop-agent:theme'

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const isTheme = (value: unknown): value is ThemePreference =>
  THEMES.includes(value as ThemePreference)

function readCache(): ThemePreference {
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    return isTheme(cached) ? cached : 'system'
  } catch {
    return 'system'
  }
}

/** Sets or clears `data-theme` on <html> and refreshes the start-up cache. */
export function applyTheme(theme: ThemePreference): void {
  if (theme === 'system') delete document.documentElement.dataset['theme']
  else document.documentElement.dataset['theme'] = theme
  try {
    localStorage.setItem(CACHE_KEY, theme)
  } catch {
    // Without storage the first paint follows the system; the saved theme still applies.
  }
}

// One shared value, so every component calling useTheme() sees the same choice.
let current: ThemePreference = readCache()
/** Bumped on each local change, so a slow `theme.get()` never overwrites a newer choice. */
let changes = 0
const listeners = new Set<() => void>()

function update(theme: ThemePreference): void {
  current = theme
  applyTheme(theme)
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTheme(): {
  theme: ThemePreference
  setTheme: (theme: ThemePreference) => Promise<void>
} {
  const api = useApi()
  const theme = useSyncExternalStore(subscribe, () => current)

  useEffect(() => {
    let live = true
    const seen = changes
    api.theme.get().then(
      (stored) => {
        if (live && seen === changes && isTheme(stored)) update(stored)
      },
      (error: unknown) => {
        console.error('theme.get failed', error)
      },
    )
    return () => {
      live = false
    }
  }, [api])

  const setTheme = useCallback(
    async (next: ThemePreference): Promise<void> => {
      const previous = current
      changes += 1
      update(next)
      try {
        const saved = await api.theme.set(next)
        if (isTheme(saved)) update(saved)
      } catch (error) {
        console.error('theme.set failed', error)
        update(previous)
      }
    },
    [api],
  )

  return { theme, setTheme }
}
