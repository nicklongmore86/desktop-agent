import type {
  ApprovalPrompt,
  ChatErrorCode,
  ChatEvent,
  ChatItem,
  ChatState,
  HistoryState,
} from '../../shared/ipc'

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
   * A switch is in progress (provider, saved chat, or New chat): the old
   * conversation is cleared and everything from it is ignored until main
   * sends the conversation it switched to.
   */
  switching: boolean
  /** What the switch in progress is for, to say so in the header. */
  switchKind: SwitchKind | null
  /** The current provider's saved chats, newest first, and the open one. */
  history: HistoryState
}

export type SwitchKind = 'provider' | 'chat'

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
  history: emptyHistory,
}

export type ChatAction =
  | { type: 'loaded'; state: ChatState }
  | { type: 'event'; event: ChatEvent }
  | { type: 'approval'; prompt: ApprovalPrompt }
  | { type: 'banner'; banner: Banner | null }
  | { type: 'dismiss_storage_warning' }
  /** The user picked another provider or chat, or New chat; main has not switched yet. */
  | { type: 'switch_started'; kind?: SwitchKind }
  /** The switch settled. `state` is main's conversation, if it could be read. */
  | { type: 'switch_finished'; state: ChatState | null }
  /** A rename or delete answered with the new list. */
  | { type: 'history'; history: HistoryState }

/** A ChatState's fields other than `history`, which the view keeps separately. */
function withoutHistory(state: ChatState | undefined): Partial<ChatViewState> {
  if (!state) return {}
  return { items: state.items, running: state.running, loadError: state.loadError }
}

function applyEvent(state: ChatViewState, event: ChatEvent): ChatViewState {
  // While a switch is in progress, everything from the old conversation is ignored:
  // only its reset, storage warnings and approval closings still apply.
  const switchSafe = ['conversation_reset', 'storage_warning', 'approval_closed']
  if (state.switching && !switchSafe.includes(event.type)) return state
  switch (event.type) {
    case 'run_started':
      return {
        ...state,
        running: true,
        runId: event.runId,
        banner: null,
        loadError: null,
        items: [...state.items, { kind: 'user', id: `${event.runId}:user`, text: event.text }],
      }
    case 'conversation_reset':
      // Only a switch's reset carries the conversation switched to; a reset without one
      // is not the end of this switch.
      if (state.switching && !event.state) return state
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
                result: { content: event.content, isError: event.isError },
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
      const kind = action.kind ?? 'provider'
      return {
        ...initialChatState,
        storageWarning: state.storageWarning,
        switching: true,
        switchKind: kind,
        // Another chat of the same provider: the list stays. Another provider: it has its own.
        history: kind === 'chat' ? state.history : emptyHistory,
      }
    }
    case 'history':
      // A list answered from before a switch may be another provider's; the switch brings its own.
      if (state.switching) return state
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
          banner: { code: 'internal', message: 'Could not load the conversation.' },
        }
      }
      return {
        ...state,
        switching: false,
        switchKind: null,
        ...withoutHistory(action.state),
        history: action.state.history ?? state.history,
      }
  }
}
