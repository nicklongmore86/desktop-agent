import { useEffect, useRef } from 'react'

export interface ShortcutHandlers {
  newChat: () => void
  openSettings: () => void
  focusComposer: () => void
}

/**
 * App-wide keyboard shortcuts: Ctrl/Cmd+N new chat, Ctrl/Cmd+, settings and
 * Ctrl/Cmd+K focus the message box. Ignored while `disabled` (an approval is open).
 */
export function useShortcuts(handlers: ShortcutHandlers, disabled: boolean): void {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    if (disabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      const action =
        key === 'n'
          ? latest.current.newChat
          : key === ','
            ? latest.current.openSettings
            : key === 'k'
              ? latest.current.focusComposer
              : null
      if (!action) return
      event.preventDefault()
      action()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [disabled])
}
