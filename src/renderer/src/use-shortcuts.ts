import { useEffect, useRef } from 'react'

export interface ShortcutHandlers {
  newChat: () => void
  openSettings: () => void
  focusComposer: () => void
}

/**
 * App-wide keyboard shortcuts: Ctrl/Cmd+N new chat, Ctrl/Cmd+, settings and
 * Ctrl/Cmd+K focus the message box. Ignored while `disabled` (an approval is open).
 * The sidebar toggles (Ctrl/Cmd+Alt+[ and ]) are below: useLayoutHotkeys.
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

export type LayoutHotkey = 'left' | 'right'

/**
 * Ctrl/Cmd+Alt+[ toggles the left sidebar and Ctrl/Cmd+Alt+] the right one. Matched on
 * the physical key (`code`), because the character depends on the keyboard layout. Key
 * repeat is ignored, and so is AltGraph: on Windows AltGr reports Ctrl+Alt, and it is how
 * many layouts type [ and ], so those presses are text, not shortcuts.
 */
export function matchLayoutHotkey(
  event: Pick<
    KeyboardEvent,
    'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'defaultPrevented'
  > & { getModifierState?: (key: string) => boolean },
): LayoutHotkey | null {
  if (event.defaultPrevented || event.repeat || event.shiftKey || !event.altKey) return null
  if (!(event.ctrlKey || event.metaKey)) return null
  if (event.getModifierState?.('AltGraph')) return null
  if (event.code === 'BracketLeft') return 'left'
  if (event.code === 'BracketRight') return 'right'
  return null
}

/** The sidebar toggles. Ignored while `disabled` (an approval or another dialog is open). */
export function useLayoutHotkeys(onToggle: (side: LayoutHotkey) => void, disabled: boolean): void {
  const latest = useRef(onToggle)
  useEffect(() => {
    latest.current = onToggle
  })
  useEffect(() => {
    if (disabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const side = matchLayoutHotkey(event)
      if (!side) return
      event.preventDefault()
      latest.current(side)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [disabled])
}
