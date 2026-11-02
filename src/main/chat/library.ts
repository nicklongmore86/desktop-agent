import type { ChatRef, ProviderChat } from '../../shared/ipc'
import { DEFAULT_CONNECTION, type ConnectionId } from '../../shared/ipc-connections'
import type { ConversationHistory } from '../storage/history-store'

/**
 * Every connection's saved chats, as one list. Nothing moves on disk: each chat
 * stays in its *home* connection's history folder and is named by
 * `ChatRef { provider: home, id }`; any connection can continue it. Only a
 * registered connection id ever becomes part of a path, so folders this build
 * does not register (a newer build's connections) are never listed.
 */
export interface ChatLibrary {
  /** The connection replies go to now. */
  connection: () => ConnectionId
  /** A registered connection's saved chats, opened on first use. Rejects any other id. */
  historyFor: (home: ConnectionId) => Promise<ConversationHistory>
  /** A history that is already open, or null. */
  loaded: (home: ConnectionId) => ConversationHistory | null
  /** Every open history's chats, newest first, each with its home. */
  list: () => ProviderChat[]
  /** Records which chat is open, across restarts. Never throws. */
  remember: (chat: ChatRef | null) => Promise<void>
}

export interface ChatLibraryDeps {
  connection: () => ConnectionId
  /** Registered connection ids, in registry order (hidden personal-use ones included). */
  registered: () => readonly ConnectionId[]
  /** Opens one connection's history folder. Only ever called with a registered id. */
  open: (home: ConnectionId) => Promise<ConversationHistory>
  remember?: (chat: ChatRef | null) => Promise<void>
  onError?: (error: unknown) => void
}

const byRecent = (a: ProviderChat, b: ProviderChat): number =>
  b.updatedAt - a.updatedAt ||
  b.createdAt - a.createdAt ||
  a.id.localeCompare(b.id) ||
  a.provider.localeCompare(b.provider)

export function createChatLibrary(
  deps: ChatLibraryDeps,
): ChatLibrary & { loadAll: () => Promise<void> } {
  const opening = new Map<ConnectionId, Promise<ConversationHistory>>()
  const open = new Map<ConnectionId, ConversationHistory>()
  const historyFor = (home: ConnectionId): Promise<ConversationHistory> => {
    if (!deps.registered().includes(home)) return Promise.reject(new Error('Unknown chat.'))
    let history = opening.get(home)
    if (!history) {
      history = deps.open(home)
      opening.set(home, history)
      history.then(
        (opened) => open.set(home, opened),
        () => opening.delete(home),
      )
    }
    return history
  }
  return {
    connection: deps.connection,
    historyFor,
    loaded: (home) => (deps.registered().includes(home) ? (open.get(home) ?? null) : null),
    list: () =>
      deps
        .registered()
        .flatMap((home) =>
          (open.get(home)?.state().conversations ?? []).map((chat) => ({
            ...chat,
            provider: home,
          })),
        )
        .sort(byRecent),
    remember: async (chat) => {
      try {
        await deps.remember?.(chat)
      } catch (error) {
        deps.onError?.(error)
      }
    },
    /** Opens every registered connection's history; one that fails stays unlisted until used. */
    async loadAll() {
      await Promise.all(
        deps.registered().map((home) =>
          historyFor(home).catch((error: unknown) => {
            deps.onError?.(error)
          }),
        ),
      )
    },
  }
}

/** One connection's history as the whole library: the chat session's default (tests). */
export function singleLibrary(
  history: ConversationHistory,
  connection: ConnectionId = DEFAULT_CONNECTION,
): ChatLibrary {
  return {
    connection: () => connection,
    historyFor: (home) =>
      home === connection ? Promise.resolve(history) : Promise.reject(new Error('Unknown chat.')),
    loaded: (home) => (home === connection ? history : null),
    list: () => history.state().conversations.map((chat) => ({ ...chat, provider: connection })),
    remember: () => Promise.resolve(),
  }
}
