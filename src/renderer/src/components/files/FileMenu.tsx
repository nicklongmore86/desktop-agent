import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

export interface FileMenuItem {
  label: string
  /** Why the item cannot be used, or null when it can. */
  disabled: string | null
  onSelect: () => void
}

/**
 * The Files tree's context menu, at the pointer (or under the row for the
 * keyboard). Arrow keys, Home/End move; Enter or a click runs an item; Escape,
 * Tab or focus leaving closes it. Unavailable items stay focusable and say why.
 */
export function FileMenu({
  x,
  y,
  label,
  note,
  items,
  onClose,
}: {
  x: number
  y: number
  label: string
  note: string | null
  items: FileMenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const noteId = useId()
  const [position, setPosition] = useState({ left: x, top: y })
  const entries = () => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ]

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect()
    if (!box) return
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    })
  }, [x, y])
  useEffect(() => {
    entries()[0]?.focus()
  }, [])

  return (
    <div
      ref={menu}
      role="menu"
      className="file-menu"
      aria-label={label}
      aria-describedby={note ? noteId : undefined}
      style={position}
      onKeyDown={(event) => {
        const list = entries()
        const index = list.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          list[(index + step + list.length) % list.length]?.focus()
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          ;(event.key === 'Home' ? list[0] : list.at(-1))?.focus()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        } else if (event.key === 'Tab') {
          event.preventDefault()
          onClose()
        }
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && menu.current?.contains(event.relatedTarget)))
          onClose()
      }}
    >
      {note && (
        <p id={noteId} className="file-menu-note">
          {note}
        </p>
      )}
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-disabled={item.disabled ? 'true' : undefined}
          title={item.disabled ?? undefined}
          onClick={() => {
            if (item.disabled) return
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
