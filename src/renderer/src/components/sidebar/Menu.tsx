import { useEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect?: () => void
  /** Shown as the item's tooltip and description; the item stays in arrow-key order. */
  disabled?: string | false
  danger?: boolean
  /** Opens a second list in place of this one (ArrowRight or Enter; ArrowLeft goes back). */
  submenu?: { label: string; items: MenuItem[] }
  /** Draws a line above the item. */
  separated?: boolean
}

export interface MenuPosition {
  top: number
  /** Either edge: under a ⋯ button it is `right`, at the pointer (right-click) `left`. */
  right?: number
  left?: number
}

/**
 * A popup menu: arrow keys, Home/End, Enter; Escape closes it and gives focus
 * back to its button. Disabled items keep their place and say why. Fixed, so
 * the list's scroll box cannot clip it; scrolling or resizing closes it.
 */
export function Menu({
  label,
  position,
  items,
  onClose,
}: {
  label: string
  position: MenuPosition
  items: MenuItem[]
  /** `refocus`: give focus back to the button that opened it (Escape, or a choice made). */
  onClose: (refocus: boolean) => void
}): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<{ label: string; items: MenuItem[]; from: number } | null>(null)
  const shown = sub ? sub.items : items
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    // Placed once: scrolling or resizing closes it rather than leaving it adrift.
    const close = (event: Event): void => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return
      closeRef.current(false)
    }
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [])
  const focusAt = (index: number): void => {
    requestAnimationFrame(() => {
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus()
    })
  }
  useEffect(() => {
    // The first item; back from a submenu, `back` then moves on to the item that opened it.
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [sub])

  const list = (): HTMLElement[] => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ]
  const choose = (item: MenuItem, index: number): void => {
    if (item.disabled) return
    if (item.submenu) {
      setSub({ ...item.submenu, from: index })
      return
    }
    item.onSelect?.()
  }
  const back = (): void => {
    if (!sub) return
    const from = sub.from
    setSub(null)
    focusAt(from)
  }

  return (
    <div
      ref={menu}
      role="menu"
      className="history-menu"
      style={position}
      aria-label={sub ? sub.label : label}
      onKeyDown={(event) => {
        const all = list()
        const index = all.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          all[(index + step + all.length) % all.length]?.focus()
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          ;(event.key === 'Home' ? all[0] : all.at(-1))?.focus()
        } else if (event.key === 'ArrowRight') {
          const item = shown[index - (sub ? 1 : 0)]
          if (item?.submenu && !item.disabled) {
            event.preventDefault()
            choose(item, index)
          }
        } else if (event.key === 'ArrowLeft' && sub) {
          event.preventDefault()
          back()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (sub) back()
          else onClose(true)
        } else if (event.key === 'Tab') {
          onClose(false)
        }
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && menu.current?.contains(event.relatedTarget)))
          onClose(false)
      }}
    >
      {sub && (
        <button type="button" role="menuitem" tabIndex={-1} className="menu-back" onClick={back}>
          <span aria-hidden="true">‹ </span>
          {sub.label}
        </button>
      )}
      {shown.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={[item.danger ? 'danger' : '', item.separated ? 'separated' : '']
            .filter(Boolean)
            .join(' ')}
          aria-disabled={item.disabled ? true : undefined}
          aria-haspopup={item.submenu ? 'menu' : undefined}
          title={item.disabled || undefined}
          onClick={() => {
            choose(item, index + (sub ? 1 : 0))
          }}
        >
          <span className="menu-label">{item.label}</span>
          {item.submenu && (
            <span className="menu-more" aria-hidden="true">
              ›
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
