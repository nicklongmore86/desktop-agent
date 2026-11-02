// Helpers for the chat session tests. Not imported by app code.
import { vi } from 'vitest'
import type {
  ConversationStore,
  MessageOrigin,
  SharingConfirmation,
  StoredMessage,
} from '../storage/conversation-store'
import type { ChatRef } from '../../shared/ipc'
import type { ConversationHistory } from '../storage/history-store'
import type { ChatLibrary } from './library'

export type MemoryStore = ConversationStore & { saved: () => StoredMessage[] }

export function memoryStore(
  initial: StoredMessage[] = [],
  initialOrigin: MessageOrigin[] = [],
): MemoryStore {
  let saved = structuredClone(initial)
  let origin: MessageOrigin[] = structuredClone(initialOrigin)
  let sharing: SharingConfirmation[] = []
  return {
    load: vi.fn(() =>
      Promise.resolve({
        messages: structuredClone(saved),
        error: null,
        ...(origin.length > 0 ? { origin: structuredClone(origin) } : {}),
        ...(sharing.length > 0 ? { sharing: structuredClone(sharing) } : {}),
      }),
    ),
    save: vi.fn(
      (
        messages: StoredMessage[],
        next: readonly MessageOrigin[] = [],
        confirmed: readonly SharingConfirmation[] = [],
      ) => {
        saved = structuredClone(messages)
        origin = structuredClone([...next])
        sharing = structuredClone([...confirmed])
        return Promise.resolve()
      },
    ),
    clear: vi.fn(() => {
      saved = []
      return Promise.resolve()
    }),
    saved: () => saved,
  }
}

export type MemoryHistory = ConversationHistory & {
  /** Every draft handed out by draft(), oldest first. */
  drafts: MemoryStore[]
  add: (id: string, store: ConversationStore) => void
}

/** An in-memory history whose open conversation is `current`. */
export function memoryHistory(current: ConversationStore = memoryStore()): MemoryHistory {
  const stores = new Map<string, ConversationStore>()
  const drafts: MemoryStore[] = []
  let activeId: string | null = null
  let open = current
  return {
    get activeId() {
      return activeId
    },
    drafts,
    add: (id, store) => {
      stores.set(id, store)
    },
    state: () => ({
      conversations: [...stores.keys()].map((id) => ({
        id,
        title: id,
        createdAt: 0,
        updatedAt: 0,
      })),
      activeId,
    }),
    has: (id) => stores.has(id),
    current: () => open,
    open: (id) => {
      const store = stores.get(id)
      if (!store) throw new Error('That chat no longer exists.')
      return store
    },
    draft: () => {
      const store = memoryStore()
      drafts.push(store)
      return store
    },
    setActive: vi.fn((id: string | null) => {
      activeId = id
      open = id === null ? (drafts.at(-1) ?? memoryStore()) : (stores.get(id) ?? open)
      return Promise.resolve()
    }),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn((id: string) => {
      stores.delete(id)
      if (activeId === id) activeId = null
      return Promise.resolve()
    }),
    organize: vi.fn(() => Promise.resolve()),
    unfile: vi.fn(() => Promise.resolve()),
    fork: vi.fn(() => Promise.reject(new Error('Forking is not supported here.'))),
  }
}

/**
 * A chat library over in-memory histories, one per connection id. `current` is the
 * connection replies go to; `remembered` records every remember() call.
 */
export function memoryLibrary(
  histories: Record<string, ConversationHistory>,
  current: string,
): ChatLibrary & { current: string; remembered: (ChatRef | null)[] } {
  const remembered: (ChatRef | null)[] = []
  const library = {
    current,
    remembered,
    connection: () => library.current,
    historyFor: (home: string) => {
      const history = histories[home]
      return history ? Promise.resolve(history) : Promise.reject(new Error('Unknown chat.'))
    },
    loaded: (home: string) => histories[home] ?? null,
    list: () =>
      Object.entries(histories).flatMap(([home, history]) =>
        history.state().conversations.map((chat) => ({ ...chat, provider: home })),
      ),
    remember: (chat: ChatRef | null) => {
      remembered.push(chat)
      return Promise.resolve()
    },
  }
  return library
}
