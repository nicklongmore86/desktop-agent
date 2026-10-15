import { useCallback, useEffect, useReducer } from 'react'
import type { ChatState, ProviderId, ProviderStatus } from '../../shared/ipc'
import { useApi } from './api'
import { chatReducer, initialChatState, type ChatViewState } from './chat-state'

export interface ChatControls {
  state: ChatViewState
  send: (text: string) => Promise<boolean>
  stop: () => Promise<void>
  newChat: () => Promise<void>
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
  const newChat = useCallback(async () => {
    dispatch({ type: 'loaded', state: await api.chat.newChat() })
  }, [api])
  const respond = useCallback(
    (id: string, approved: boolean) => api.approvals.respond(id, approved),
    [api],
  )
  const switchProvider = useCallback(
    async (provider: ProviderId) => {
      dispatch({ type: 'switch_started' })
      try {
        return await api.provider.set(provider)
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
    respond,
    switchProvider,
    dismissBanner,
    dismissStorageWarning,
  }
}
