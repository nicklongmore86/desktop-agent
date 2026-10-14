import { useCallback, useEffect, useReducer } from 'react'
import { useApi } from './api'
import { chatReducer, initialChatState, type ChatViewState } from './chat-state'

export interface ChatControls {
  state: ChatViewState
  send: (text: string) => Promise<boolean>
  stop: () => Promise<void>
  newChat: () => Promise<void>
  respond: (id: string, approved: boolean) => Promise<void>
  dismissBanner: () => void
}

/** Chat state for the whole app: subscribes to main's pushes, then loads the saved chat. */
export function useChat(): ChatControls {
  const api = useApi()
  const [state, dispatch] = useReducer(chatReducer, initialChatState)

  useEffect(() => {
    let active = true
    const offEvent = api.onChatEvent((event) => {
      dispatch({ type: 'event', event })
    })
    const offApproval = api.onApprovalRequest((prompt) => {
      dispatch({ type: 'approval', prompt })
    })
    api.chat.load().then(
      (loaded) => {
        if (active) dispatch({ type: 'loaded', state: loaded })
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
  const dismissBanner = useCallback(() => {
    dispatch({ type: 'banner', banner: null })
  }, [])

  return { state, send, stop, newChat, respond, dismissBanner }
}
