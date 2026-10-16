// Helpers for the chat session tests. Not imported by app code.
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { vi } from 'vitest'
import type { ConversationStore } from '../storage/conversation-store'
import type { ConversationHistory } from '../storage/history-store'

export type MemoryStore = ConversationStore & { saved: () => MessageParam[] }

export function memoryStore(initial: MessageParam[] = []): MemoryStore {
  let saved = structuredClone(initial)
  return {
    load: vi.fn(() => Promise.resolve({ messages: structuredClone(saved), error: null })),
    save: vi.fn((messages: MessageParam[]) => {
      saved = structuredClone(messages)
      return Promise.resolve()
    }),
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
  }
}
