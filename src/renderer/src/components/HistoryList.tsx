import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ConversationSummary, HistoryState } from '../../../shared/ipc'

const DAY = 24 * 60 * 60 * 1000

export interface HistoryGroup {
  label: 'Today' | 'Previous 7 days' | 'Older'
  conversations: ConversationSummary[]
}

/** Groups chats (already newest first) by when they were last used, in local time. */
export function groupConversations(
  conversations: readonly ConversationSummary[],
  now: number = Date.now(),
): HistoryGroup[] {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  const groups: HistoryGroup[] = [
    { label: 'Today', conversations: [] },
    { label: 'Previous 7 days', conversations: [] },
    { label: 'Older', conversations: [] },
  ]
  for (const conversation of conversations) {
    const index =
      conversation.updatedAt >= today ? 0 : conversation.updatedAt >= today - 7 * DAY ? 1 : 2
    groups[index]?.conversations.push(conversation)
  }
  return groups.filter((group) => group.conversations.length > 0)
}

export interface HistoryListProps {
  history: HistoryState
  /** A switch is under way: opening another chat waits until it is done. */
  busy: boolean
  onOpen: (id: string) => void
  /** Resolves false when the rename failed (the app shows why). */
  onRename: (id: string, title: string) => Promise<boolean>
  /** Asks the user to confirm, then deletes. */
  onDelete: (conversation: ConversationSummary) => void
  /** Show the "Chats" label (the drawer has its own heading). */
  showLabel?: boolean
  /** For tests: what "today" is. */
  now?: number
}

/** The longest name a rename sends; main cuts names to the same length. */
const MAX_NAME = 100

function RenameField({
  initial,
  onDone,
}: {
  initial: string
  onDone: (title: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (title: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(title)
  }
  return (
    <input
      ref={input}
      className="history-rename"
      aria-label="Chat name"
      value={value}
      maxLength={MAX_NAME}
      onChange={(event) => {
        setValue(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(value)
        } else if (event.key === 'Escape') {
          // Handled here: Escape must not also stop a running reply.
          event.preventDefault()
          event.stopPropagation()
          finish(null)
        }
      }}
      onBlur={() => {
        finish(value)
      }}
    />
  )
}

interface MenuPosition {
  top: number
  right: number
}

function ItemMenu({
  title,
  position,
  onRename,
  onDelete,
  onClose,
}: {
  title: string
  /** Under the ⋯ button, fixed, so the list's scroll box cannot clip it. */
  position: MenuPosition
  onRename: () => void
  onDelete: () => void
  /** `refocus`: give focus back to the menu button (Escape, or a choice made). */
  onClose: (refocus: boolean) => void
}): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    // Placed once: scrolling or resizing closes it rather than leaving it adrift.
    const close = (event: Event): void => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return
      onClose(false)
    }
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [onClose])
  const items = (): HTMLElement[] => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ]
  return (
    <div
      ref={menu}
      role="menu"
      className="history-menu"
      style={position}
      aria-label={`Options for ${title}`}
      onKeyDown={(event) => {
        const list = items()
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
          onClose(true)
        } else if (event.key === 'Tab') {
          onClose(false)
        }
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && menu.current?.contains(event.relatedTarget)))
          onClose(false)
      }}
    >
      <button type="button" role="menuitem" tabIndex={-1} onClick={onRename}>
        Rename
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className="danger" onClick={onDelete}>
        Delete…
      </button>
    </div>
  )
}

/**
 * The current provider's saved chats, grouped by date. Each opens with Enter
 * or a click; arrow keys (and Home/End) move between them; F2 renames; the
 * ⋯ menu renames or deletes. Titles are plain text from main, isolated so a
 * right-to-left title cannot reorder the text around it.
 */
export function HistoryList({
  history,
  busy,
  onOpen,
  onRename,
  onDelete,
  showLabel = true,
  now,
}: HistoryListProps): React.JSX.Element {
  const [menu, setMenu] = useState<{ id: string; position: MenuPosition } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const labelId = useId()
  const groups = groupConversations(history.conversations, now)

  const control = (id: string, selector: '.history-open' | '.history-more') =>
    [...(list.current?.querySelectorAll<HTMLElement>(selector) ?? [])].find(
      (element) => element.dataset['id'] === id,
    )
  const focusLater = (id: string, selector: '.history-open' | '.history-more'): void => {
    requestAnimationFrame(() => control(id, selector)?.focus())
  }

  // Stable, so the open menu's listeners are not re-attached on every render.
  const closeMenu = useCallback((refocus: boolean): void => {
    setMenu((open) => {
      if (open && refocus) {
        requestAnimationFrame(() => control(open.id, '.history-more')?.focus())
      }
      return null
    })
  }, [])

  const onItemKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    conversation: ConversationSummary,
  ): void => {
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>('.history-open') ?? [])]
    const index = buttons.indexOf(event.currentTarget)
    const target =
      event.key === 'ArrowDown'
        ? buttons[index + 1]
        : event.key === 'ArrowUp'
          ? buttons[index - 1]
          : event.key === 'Home'
            ? buttons[0]
            : event.key === 'End'
              ? buttons.at(-1)
              : undefined
    if (target) {
      event.preventDefault()
      target.focus()
    } else if (event.key === 'F2') {
      event.preventDefault()
      setRenaming(conversation.id)
    }
  }

  return (
    <nav className="sidebar-section sidebar-history" aria-label="Chats">
      {showLabel && (
        <span className="sidebar-label" aria-hidden="true">
          Chats
        </span>
      )}
      <div ref={list} className="history-scroll">
        {groups.length === 0 ? (
          <p className="sidebar-hint">No saved chats yet</p>
        ) : (
          groups.map((group, index) => (
            <section
              key={group.label}
              className="history-group"
              aria-labelledby={`${labelId}-${String(index)}`}
            >
              <h2 className="history-group-label" id={`${labelId}-${String(index)}`}>
                {group.label}
              </h2>
              <ul>
                {group.conversations.map((conversation) => {
                  const active = conversation.id === history.activeId
                  return (
                    <li
                      key={conversation.id}
                      className="history-item"
                      data-active={active || undefined}
                    >
                      {renaming === conversation.id ? (
                        <RenameField
                          initial={conversation.title}
                          onDone={(title) => {
                            setRenaming(null)
                            focusLater(conversation.id, '.history-open')
                            const next = title?.trim()
                            if (next && next !== conversation.title)
                              void onRename(conversation.id, next)
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="history-open"
                          data-id={conversation.id}
                          aria-current={active ? 'page' : undefined}
                          title={conversation.title}
                          onClick={() => {
                            if (!busy && !active) onOpen(conversation.id)
                          }}
                          onKeyDown={(event) => {
                            onItemKeyDown(event, conversation)
                          }}
                        >
                          <bdi className="history-title">{conversation.title}</bdi>
                        </button>
                      )}
                      <button
                        type="button"
                        className="history-more"
                        data-id={conversation.id}
                        aria-label={`Options for ${conversation.title}`}
                        aria-haspopup="menu"
                        aria-expanded={menu?.id === conversation.id}
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect()
                          setMenu((open) =>
                            open?.id === conversation.id
                              ? null
                              : {
                                  id: conversation.id,
                                  position: {
                                    top: rect.bottom,
                                    right: Math.max(0, window.innerWidth - rect.right),
                                  },
                                },
                          )
                        }}
                      >
                        <span aria-hidden="true">⋯</span>
                      </button>
                      {menu?.id === conversation.id && (
                        <ItemMenu
                          title={conversation.title}
                          position={menu.position}
                          onClose={closeMenu}
                          onRename={() => {
                            setMenu(null)
                            setRenaming(conversation.id)
                          }}
                          onDelete={() => {
                            setMenu(null)
                            // The confirmation gives focus back here when it closes.
                            control(conversation.id, '.history-more')?.focus()
                            onDelete(conversation)
                          }}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </nav>
  )
}
