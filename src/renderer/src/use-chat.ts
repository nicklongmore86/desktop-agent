import { useCallback, useEffect, useReducer } from 'react'
import type { ChatState, ProviderId, ProviderStatus } from '../../shared/ipc'
import { useApi } from './api'
import { chatReducer, initialChatState, type ChatViewState, type SwitchKind } from './chat-state'

export interface ChatControls {
  state: ChatViewState
  send: (text: string) => Promise<boolean>
  stop: () => Promise<void>
  /** Starts a new chat; the open one stays in the history. */
  newChat: () => Promise<void>
  /**
   * Opens a saved chat. Like a provider switch, the open conversation is hidden
   * and sends are refused until main has loaded the other one; a running reply
   * is stopped (main saves it to its own chat and denies its approvals).
   */
  openConversation: (id: string) => Promise<void>
  /** Resolves false (with a banner) when the rename failed. */
  renameConversation: (id: string, title: string) => Promise<boolean>
  /** Deleting the open chat starts a new one, through the same switch as New chat. */
  deleteConversation: (id: string) => Promise<void>
  respond: (id: string, approved: boolean) => Promise<void>
  /** Switches provider, hiding the old conversation until the new one arrives. */
  switchProvider: (provider: ProviderId) => Promise<ProviderStatus>
  dismissBanner: () => void
  dismissStorageWarning: () => void
}

/** Chat state for the whole app: subscribes to main's pushes, then loads the saved chat. */
export function useChat(): ChatControls {
  const api = useApi()
  const [state, dispatch] = useReducer(chatReducer, initialChatState)

  useEffect(() => {
    let active = true
    let resetReceived = false
    const offEvent = api.onChatEvent((event) => {
      if (event.type === 'conversation_reset') resetReceived = true
      dispatch({ type: 'event', event })
    })
    const offApproval = api.onApprovalRequest((prompt) => {
      dispatch({ type: 'approval', prompt })
    })
    api.chat.load().then(
      (loaded) => {
        if (active && !resetReceived) dispatch({ type: 'loaded', state: loaded })
      },
      () => {
        if (active)
          dispatch({
            type: 'banner',
            banner: { code: 'internal', message: 'Could not load the conversation.' },
          })
      },
    )
    return () => {
      active = false
      offEvent()
      offApproval()
    }
  }, [api])

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        const result = await api.chat.send(text)
        if (!result.ok) {
          dispatch({ type: 'banner', banner: { code: result.code, message: result.message } })
        }
        return result.ok
      } catch {
        dispatch({
          type: 'banner',
          banner: { code: 'internal', message: 'Could not send the message.' },
        })
        return false
      }
    },
    [api],
  )

  const stop = useCallback(() => api.chat.stop(), [api])

  /**
   * Hides the open conversation and ignores everything from it until `change`
   * settles, then shows whatever conversation main has (normally its
   * conversation_reset has already done so).
   */
  const switchTo = useCallback(
    async <T>(kind: SwitchKind, change: () => Promise<T>): Promise<T> => {
      dispatch({ type: 'switch_started', kind })
      try {
        return await change()
      } finally {
        let loaded: ChatState | null = null
        try {
          loaded = await api.chat.load()
        } catch {
          // switch_finished reports it.
        }
        dispatch({ type: 'switch_finished', state: loaded })
      }
    },
    [api],
  )

  const newChat = useCallback(async () => {
    try {
      await switchTo('chat', () => api.chat.newChat())
    } catch {
      dispatch({
        type: 'banner',
        banner: { code: 'internal', message: 'Could not start a new chat.' },
      })
    }
  }, [api, switchTo])
  const openConversation = useCallback(
    async (id: string) => {
      try {
        await switchTo('chat', () => api.chat.open(id))
      } catch {
        dispatch({
          type: 'banner',
          banner: { code: 'internal', message: 'Could not open that chat.' },
        })
      }
    },
    [api, switchTo],
  )
  const renameConversation = useCallback(
    async (id: string, title: string) => {
      try {
        dispatch({ type: 'history', history: await api.chat.rename(id, title) })
        return true
      } catch {
        dispatch({
          type: 'banner',
          banner: { code: 'internal', message: 'Could not rename the chat.' },
        })
        return false
      }
    },
    [api],
  )
  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        const remove = () => api.chat.remove(id)
        const history =
          id === state.history.activeId ? await switchTo('chat', remove) : await remove()
        dispatch({ type: 'history', history })
      } catch {
        dispatch({
          type: 'banner',
          banner: { code: 'internal', message: 'Could not delete the chat.' },
        })
      }
    },
    [api, switchTo, state.history.activeId],
  )
  const respond = useCallback(
    (id: string, approved: boolean) => api.approvals.respond(id, approved),
    [api],
  )
  const switchProvider = useCallback(
    (provider: ProviderId) => switchTo('provider', () => api.provider.set(provider)),
    [api, switchTo],
  )
  const dismissBanner = useCallback(() => {
    dispatch({ type: 'banner', banner: null })
  }, [])

  const dismissStorageWarning = useCallback(() => {
    dispatch({ type: 'dismiss_storage_warning' })
  }, [])

  return {
    state,
    send,
    stop,
    newChat,
    openConversation,
    renameConversation,
    deleteConversation,
    respond,
    switchProvider,
    dismissBanner,
    dismissStorageWarning,
  }
}
