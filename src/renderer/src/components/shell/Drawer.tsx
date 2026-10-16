import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]'

/**
 * A pane as a modal drawer, for windows too narrow to dock it. Escape or the scrim
 * closes it, Tab stays inside, and focus returns to what had it before (the button
 * or shortcut that opened it). The page behind is inert (the shell sets that).
 * Hidden while an approval is open, like Settings: the approval always wins focus.
 */
export function Drawer({
  side,
  id,
  label,
  closeLabel,
  suspended,
  onClose,
  children,
}: {
  side: 'left' | 'right'
  id: string
  label: string
  closeLabel: string
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
      className="shell-drawer-backdrop"
      data-side={side}
      hidden={suspended}
      inert={suspended}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        id={id}
        className="shell-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={label}
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
          const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
            (item) => item.tabIndex >= 0,
          )
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
        <header className="shell-drawer-header">
          <h2>{label}</h2>
          <button type="button" aria-label={closeLabel} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="shell-drawer-body">{children}</div>
      </div>
    </div>
  )
}
