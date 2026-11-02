import type {
  ApprovalPrompt,
  ChatErrorCode,
  ChatEvent,
  ChatItem,
  ChatState,
  HistoryState,
} from '../../shared/ipc'
import type { ConnectionId } from '../../shared/ipc-connections'
import type { ChatRef } from '../../shared/ipc-projects'

/** A chat item as shown: saved items, plus live ones tagged with their run and turn. */
export type ViewItem =
  | Extract<ChatItem, { kind: 'user' }>
  | (Extract<ChatItem, { kind: 'tool' }> & {
      /** Live calls only: when the call began and when its result arrived (epoch ms). */
      startedAt?: number
      endedAt?: number
    })
  | {
      kind: 'assistant'
      id: string
      text: string
      runId?: string
      turn?: number
      /** The run was stopped while this reply streamed; it was not saved. */
      stopped?: boolean
      /** Provenance of a saved reply (see ChatItem); live replies get the current connection's. */
      connection?: ConnectionId
      model?: string
    }

export interface Banner {
  code: ChatErrorCode
  message: string
}

export interface ChatViewState {
  items: ViewItem[]
  running: boolean
  runId: string | null
  banner: Banner | null
  /** Approval prompts waiting for the user, oldest first. */
  approvals: ApprovalPrompt[]
  loadError: string | null
  /** Saving or deleting the conversation on disk failed. */
  storageWarning: string | null
  /**
   * A switch is in progress (connection, saved chat, or New chat). A chat or New chat switch
   * clears the old conversation; a connection switch keeps it on screen. Either way,
   * everything from the old conversation is ignored until main sends the one switched to.
   */
  switching: boolean
  /** What the switch in progress is for, to say so in the header. */
  switchKind: SwitchKind | null
  /** A connection switch: the connection being switched to (to say so), if known. */
  switchTo: ConnectionId | null
  /** A connection switch: the chat it continues; only a reset for this chat ends it. */
  switchChat: ChatRef | null
  /** The shared chat list (every connection's chats) and the open chat. */
  history: HistoryState
}

/**
 * 'chat': another saved chat or a new one (the screen clears). 'connection': the open chat
 * continues on another connection (the chat and the list stay).
 */
export type SwitchKind = 'chat' | 'connection'

export const emptyHistory: HistoryState = { conversations: [], activeId: null }

export const initialChatState: ChatViewState = {
  items: [],
  running: false,
  runId: null,
  banner: null,
  approvals: [],
  loadError: null,
  storageWarning: null,
  switching: false,
  switchKind: null,
  switchTo: null,
  switchChat: null,
  history: emptyHistory,
}

export type ChatAction =
  | { type: 'loaded'; state: ChatState }
  | { type: 'event'; event: ChatEvent }
  | { type: 'approval'; prompt: ApprovalPrompt }
  | { type: 'banner'; banner: Banner | null }
  | { type: 'dismiss_storage_warning' }
  /**
   * The user picked another connection or chat, or New chat; main has not switched yet.
   * `to` names the connection of a 'connection' switch.
   */
  | { type: 'switch_started'; kind?: SwitchKind; to?: ConnectionId }
  /** The switch settled. `state` is main's conversation, if it could be read. */
  | { type: 'switch_finished'; state: ChatState | null }
  /** A rename or delete answered with the new list. */
  | { type: 'history'; history: HistoryState }

const sameChat = (a: ChatRef | null | undefined, b: ChatRef | null): boolean =>
  a ? b !== null && a.provider === b.provider && a.id === b.id : b === null

/** The open chat by home and id; null for a new chat that is not saved yet. */
export function activeChat(history: HistoryState): ChatRef | null {
  return history.active ?? null
}

/** A ChatState's fields other than `history`, which the view keeps separately. */
function withoutHistory(state: ChatState | undefined): Partial<ChatViewState> {
  if (!state) return {}
  return { items: state.items, running: state.running, loadError: state.loadError }
}

function applyEvent(state: ChatViewState, event: ChatEvent): ChatViewState {
  // While a switch is in progress, everything from the old conversation is ignored:
  // only its reset, storage warnings and approval closings still apply.
  // A connection switch keeps the shared chat list live too: it is not the old chat's.
  const switchSafe = ['conversation_reset', 'storage_warning', 'approval_closed']
  if (state.switchKind === 'connection') switchSafe.push('history_changed')
  if (state.switching && !switchSafe.includes(event.type)) return state
  switch (event.type) {
    case 'run_started':
      return {
        ...state,
        running: true,
        runId: event.runId,
        banner: null,
        loadError: null,
        items: [
          ...state.items,
          {
            kind: 'user',
            id: `${event.runId}:user`,
            text: event.text,
            ...(event.attachments && event.attachments.length > 0
              ? { attachments: event.attachments.map((a) => ({ ...a, available: true })) }
              : {}),
          },
        ],
      }
    case 'command_started':
      // A command typed in the command bar: its card, with the result to come.
      return {
        ...state,
        running: true,
        runId: event.runId,
        banner: null,
        loadError: null,
        items: [
          ...state.items,
          {
            kind: 'tool',
            id: event.id,
            name: 'run_shell',
            input: { command: event.command, cwd: event.cwd },
            result: null,
            origin: 'user-terminal',
            startedAt: Date.now(),
          },
        ],
      }
    case 'conversation_reset':
      // Only a switch's reset carries the conversation switched to; a reset without one
      // is not the end of this switch.
      if (state.switching && !event.state) return state
      // A connection switch ends with the reset of the chat it continues; a reset for any
      // other chat is not ours (switch_finished shows whatever main has if ours is lost).
      if (
        state.switchKind === 'connection' &&
        event.state &&
        !sameChat(event.state.history?.active, state.switchChat)
      )
        return state
      // Keep a storage warning: a failed save is reported just before the reset.
      return {
        ...initialChatState,
        ...withoutHistory(event.state),
        history: event.state?.history ?? state.history,
        storageWarning: state.storageWarning,
      }
    case 'history_changed':
      return { ...state, history: event.history }
    case 'storage_warning':
      return { ...state, storageWarning: event.message }
    case 'approval_closed':
      return {
        ...state,
        approvals: state.approvals.filter((prompt) => prompt.id !== event.approvalId),
      }
    default:
      break
  }
  // Everything else belongs to a run; ignore stragglers from one that is over.
  if (event.runId !== state.runId) return state
  switch (event.type) {
    case 'text_delta': {
      const last = state.items.at(-1)
      if (last?.kind === 'assistant' && last.runId === event.runId && last.turn === event.turn) {
        return {
          ...state,
          items: [...state.items.slice(0, -1), { ...last, text: last.text + event.text }],
        }
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: 'assistant',
            id: `${event.runId}:${String(event.turn)}:${String(state.items.length)}`,
            text: event.text,
            runId: event.runId,
            turn: event.turn,
          },
        ],
      }
    }
    case 'response_discarded':
      // Roll back the streamed text of the dropped response: it was never saved.
      return {
        ...state,
        items: state.items.filter(
          (item) =>
            !(item.kind === 'assistant' && item.runId === event.runId && item.turn === event.turn),
        ),
      }
    case 'tool_use':
      if (state.items.some((item) => item.kind === 'tool' && item.id === event.id)) return state
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: 'tool',
            id: event.id,
            name: event.name,
            input: event.input,
            result: null,
            startedAt: Date.now(),
          },
        ],
      }
    case 'tool_result':
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === 'tool' && item.id === event.id
            ? {
                ...item,
                result: {
                  content: event.content,
                  isError: event.isError,
                  declined: event.declined,
                },
                endedAt: Date.now(),
              }
            : item,
        ),
      }
    case 'error': {
      if (event.code !== 'aborted') {
        return { ...state, banner: { code: event.code, message: event.message } }
      }
      // A reply still streaming when the user pressed Stop is not saved; say so.
      const last = state.items.at(-1)
      const items =
        last?.kind === 'assistant' && last.runId === event.runId
          ? [...state.items.slice(0, -1), { ...last, stopped: true }]
          : state.items
      return {
        ...state,
        items,
        banner: { code: event.code, message: 'Any unfinished reply was not saved.' },
      }
    }
    case 'run_finished':
      return {
        ...state,
        running: false,
        runId: null,
        approvals: state.approvals.filter((prompt) => prompt.runId !== event.runId),
      }
  }
}

export function chatReducer(state: ChatViewState, action: ChatAction): ChatViewState {
  switch (action.type) {
    case 'loaded':
      // A load or New chat answered from before the switch: that history is the old provider's.
      if (state.switching) return state
      return {
        ...state,
        ...withoutHistory(action.state),
        history: action.state.history ?? state.history,
      }
    case 'event':
      return applyEvent(state, action.event)
    case 'approval':
      // Main denies the old run's prompts when the switch starts; never show one meanwhile.
      if (state.switching) return state
      if (state.approvals.some((prompt) => prompt.id === action.prompt.id)) return state
      return { ...state, approvals: [...state.approvals, action.prompt] }
    case 'banner':
      return { ...state, banner: action.banner }
    case 'dismiss_storage_warning':
      return { ...state, storageWarning: null }
    case 'switch_started': {
      const kind = action.kind ?? 'chat'
      if (kind === 'connection') {
        // The chat stays on screen, still, and the list stays. Main stops a running reply and
        // denies its approvals as the switch starts, so none is shown meanwhile.
        return {
          ...state,
          running: false,
          runId: null,
          approvals: [],
          banner: null,
          switching: true,
          switchKind: 'connection',
          switchTo: action.to ?? null,
          switchChat: activeChat(state.history),
        }
      }
      return {
        ...initialChatState,
        storageWarning: state.storageWarning,
        switching: true,
        switchKind: kind,
        // The list is shared by every connection: it stays.
        history: state.history,
      }
    }
    case 'history':
      // An answer from before a chat switch may predate it; that switch brings its own list.
      if (state.switching && state.switchKind !== 'connection') return state
      return { ...state, history: action.history }
    case 'switch_finished':
      // Normally the switch's conversation_reset has already ended it. If not (the switch
      // failed, or the reset was lost), show whatever conversation main now has.
      if (!state.switching) return state
      if (!action.state) {
        return {
          ...state,
          switching: false,
          switchKind: null,
          switchTo: null,
          switchChat: null,
          banner: { code: 'internal', message: 'Could not load the conversation.' },
        }
      }
      return {
        ...state,
        switching: false,
        switchKind: null,
        switchTo: null,
        switchChat: null,
        ...withoutHistory(action.state),
        history: action.state.history ?? state.history,
      }
  }
}
