import { useEffect, useRef } from 'react'

/**
 * The chat list for narrow windows, where the sidebar is hidden: a modal
 * panel from the left. Escape or the backdrop closes it, Tab stays inside,
 * and focus returns to the button that opened it. Hidden while an approval
 * is open, like Settings.
 */
export function HistoryDrawer({
  suspended,
  onClose,
  children,
}: {
  suspended: boolean
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (!suspended) panel.current?.focus()
  }, [suspended])
  return (
    <div
      className="history-drawer-backdrop"
      hidden={suspended}
      inert={suspended}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        id="history-drawer"
        className="history-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Chats"
        tabIndex={-1}
        onKeyDown={(event) => {
          // Menus and rename fields inside handle their own Escape first.
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          const items = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled)',
            ) ?? []),
          ].filter((item) => item.tabIndex >= 0)
          const first = items[0]
          const last = items.at(-1)
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === panel.current)
          ) {
            event.preventDefault()
            last?.focus()
          } else if (
            !event.shiftKey &&
            (document.activeElement === last || document.activeElement === panel.current)
          ) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <header className="history-drawer-header">
          <h2>Chats</h2>
          <button type="button" aria-label="Close chats" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
