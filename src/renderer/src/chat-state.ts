import type {
  ApprovalPrompt,
  ChatErrorCode,
  ChatEvent,
  ChatItem,
  ChatState,
} from '../../shared/ipc'

/** A chat item as shown: saved items, plus live ones tagged with their run and turn. */
export type ViewItem =
  | Extract<ChatItem, { kind: 'user' | 'tool' }>
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
   * A provider switch is in progress: the old conversation is cleared and
   * everything from it is ignored until main sends the new provider's history.
   */
  switching: boolean
}

export const initialChatState: ChatViewState = {
  items: [],
  running: false,
  runId: null,
  banner: null,
  approvals: [],
  loadError: null,
  storageWarning: null,
  switching: false,
}

export type ChatAction =
  | { type: 'loaded'; state: ChatState }
  | { type: 'event'; event: ChatEvent }
  | { type: 'approval'; prompt: ApprovalPrompt }
  | { type: 'banner'; banner: Banner | null }
  | { type: 'dismiss_storage_warning' }
  /** The user picked another provider; main has not switched yet. */
  | { type: 'switch_started' }
  /** provider.set settled. `state` is main's conversation, if it could be read. */
  | { type: 'switch_finished'; state: ChatState | null }

function applyEvent(state: ChatViewState, event: ChatEvent): ChatViewState {
  // While a provider switch is in progress, everything from the old provider is ignored:
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
      // Only a switch's reset carries the new provider's history; a New chat queued
      // before the switch resets to empty, and the switch is still under way.
      if (state.switching && !event.state) return state
      // Keep a storage warning: a failed delete is reported just before the reset.
      return { ...initialChatState, ...(event.state ?? {}), storageWarning: state.storageWarning }
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
          { kind: 'tool', id: event.id, name: event.name, input: event.input, result: null },
        ],
      }
    case 'tool_result':
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === 'tool' && item.id === event.id
            ? { ...item, result: { content: event.content, isError: event.isError } }
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
        items: action.state.items,
        running: action.state.running,
        loadError: action.state.loadError,
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
    case 'switch_started':
      return { ...initialChatState, storageWarning: state.storageWarning, switching: true }
    case 'switch_finished':
      // Normally the switch's conversation_reset has already ended it. If not (the switch
      // failed, or the reset was lost), show whatever conversation main now has.
      if (!state.switching) return state
      if (!action.state) {
        return {
          ...state,
          switching: false,
          banner: { code: 'internal', message: 'Could not load the conversation.' },
        }
      }
      return {
        ...state,
        switching: false,
        items: action.state.items,
        running: action.state.running,
        loadError: action.state.loadError,
      }
  }
}
