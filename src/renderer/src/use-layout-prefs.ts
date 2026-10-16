import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_LAYOUT, type LayoutPrefs } from '../../shared/ipc-layout'
import { useApi } from './api'

/** Writes wait for the user to stop dragging or typing before they go to main. */
export const LAYOUT_SAVE_DELAY = 500

export interface LayoutPrefsControl {
  prefs: LayoutPrefs
  /** False until the saved layout has loaded, so the first paint does not animate into place. */
  ready: boolean
  update: (changes: Partial<Omit<LayoutPrefs, 'version'>>) => void
}

/**
 * The saved sidebar layout. Loaded once from main (which validates it), changed
 * locally at once and saved debounced; the last change is flushed when the page
 * goes away. Saving is best effort: a failure costs only the preference.
 */
export function useLayoutPrefs(): LayoutPrefsControl {
  const api = useApi()
  const [prefs, setPrefs] = useState<LayoutPrefs>(DEFAULT_LAYOUT)
  const [ready, setReady] = useState(false)
  const latest = useRef(prefs)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirty = useRef(false)

  const flush = useCallback(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
    api.layout.set(latest.current).catch((error: unknown) => {
      console.error('layout.set failed', error)
    })
  }, [api])

  useEffect(() => {
    let cancelled = false
    api.layout.get().then(
      (saved) => {
        if (cancelled) return
        // A change made before the load finished wins over the saved value.
        if (!dirty.current) {
          latest.current = saved
          setPrefs(saved)
        }
        setReady(true)
      },
      (error: unknown) => {
        console.error('layout.get failed', error)
        if (!cancelled) setReady(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  const update = useCallback(
    (changes: Partial<Omit<LayoutPrefs, 'version'>>) => {
      const next = { ...latest.current, ...changes }
      if (JSON.stringify(next) === JSON.stringify(latest.current)) return
      dirty.current = true
      latest.current = next
      setPrefs(next)
      clearTimeout(timer.current)
      timer.current = setTimeout(flush, LAYOUT_SAVE_DELAY)
    },
    [flush],
  )

  return { prefs, ready, update }
}
