import { useEffect, useState } from 'react'
import type { ViewMode } from './components/ViewModeToggle'

const STORAGE_KEY = 'desktop-agent.chat-views'
/** Only chats left in Command view are stored; the oldest go first past this many. */
const MAX_STORED = 500

/** Chat id -> 'command'. A per-viewer convenience: an unreadable store means Chat everywhere. */
type StoredViews = Record<string, 'command'>

function readViews(): StoredViews {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const views: StoredViews = {}
    for (const [id, view] of Object.entries(parsed)) if (view === 'command') views[id] = 'command'
    return views
  } catch {
    return {}
  }
}

function withView(views: StoredViews, id: string, view: ViewMode): StoredViews {
  const { [id]: _old, ...rest } = views
  if (view !== 'command') return rest
  const ids = Object.keys(rest)
  const kept = ids.length >= MAX_STORED ? ids.slice(ids.length - MAX_STORED + 1) : ids
  return { ...Object.fromEntries(kept.map((key) => [key, 'command' as const])), [id]: 'command' }
}

/**
 * The open chat's view (Chat or Command), remembered per chat in localStorage. A new,
 * unsaved chat starts in Chat; the view chosen there carries over when its first message
 * or command saves it (its id appears without a switch), not when another chat is opened.
 */
export function useChatView(
  activeId: string | null,
  switching: boolean,
): [ViewMode, (view: ViewMode) => void] {
  const [views, setViews] = useState<StoredViews>(readViews)
  const [draftView, setDraftView] = useState<ViewMode>('chat')
  // The chat last seen, and whether a switch has started since.
  const [seen, setSeen] = useState({ id: activeId, switched: switching })
  if (seen.id !== activeId) {
    if (seen.id === null && !seen.switched && !switching && activeId !== null) {
      setViews(withView(views, activeId, draftView))
    }
    if (activeId === null) setDraftView('chat')
    setSeen({ id: activeId, switched: switching })
  } else if (switching && !seen.switched) {
    setSeen({ id: activeId, switched: true })
  }

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(views))
    } catch {
      // Storage is unavailable (private window, blocked): the view is simply not remembered.
    }
  }, [views])

  const view = activeId === null ? draftView : (views[activeId] ?? 'chat')
  const setView = (next: ViewMode): void => {
    if (activeId === null) setDraftView(next)
    else setViews((current) => withView(current, activeId, next))
  }
  return [view, setView]
}
