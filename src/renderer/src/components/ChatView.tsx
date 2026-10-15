import { useEffect, useRef, useState, type SubmitEvent } from 'react'
import type { ChatViewState } from '../chat-state'
import { ErrorBanner } from './ErrorBanner'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'

export interface ChatViewProps {
  state: ChatViewState
  onSend: (text: string) => Promise<boolean>
  onStop: () => Promise<void>
  onNewChat: () => Promise<void>
  onDismissBanner: () => void
  onDismissStorageWarning: () => void
  onOpenSettings: () => void
  /** Shown above the composer when setup is incomplete. */
  notice?: React.ReactNode
}

export function ChatView({
  state,
  onSend,
  onStop,
  onNewChat,
  onDismissBanner,
  onDismissStorageWarning,
  onOpenSettings,
  notice,
}: ChatViewProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listEnd = useRef<HTMLLIElement>(null)

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' })
  }, [state.items])

  const send = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || state.running || state.switching || sending) return
    setSending(true)
    try {
      if (await onSend(text)) setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <button
          type="button"
          disabled={state.switching}
          onClick={() => {
            void onNewChat()
          }}
        >
          New chat
        </button>
      </div>

      {state.storageWarning && (
        <div className="banner banner-warning" role="alert">
          <div className="banner-text">
            <strong>Storage problem.</strong> {state.storageWarning}
          </div>
          <button
            type="button"
            aria-label="Dismiss storage warning"
            onClick={onDismissStorageWarning}
          >
            ×
          </button>
        </div>
      )}

      {state.loadError && (
        <div className="banner banner-info" role="status">
          {state.loadError}
        </div>
      )}

      <ol className="messages" aria-label="Messages">
        {state.switching && (
          <li className="messages-empty" role="status">
            Switching provider…
          </li>
        )}
        {state.items.length === 0 && !state.switching && (
          <li className="messages-empty">Ask Claude to look at or change files in your folders.</li>
        )}
        {state.items.map((item) => {
          if (item.kind === 'tool') {
            return (
              <li key={item.id} className="message message-tool">
                <ToolCard item={item} running={state.running} />
              </li>
            )
          }
          if (item.kind === 'user') {
            return (
              <li key={item.id} className="message message-user">
                {item.text}
              </li>
            )
          }
          return (
            <li key={item.id} className="message message-assistant">
              <Markdown text={item.text} />
              {item.stopped && <p className="message-note">Stopped. This reply was not saved.</p>}
            </li>
          )
        })}
        {state.running && (
          <li className="message-progress" role="status" aria-live="polite">
            Claude is working…
          </li>
        )}
        <li ref={listEnd} aria-hidden="true" />
      </ol>

      {state.banner && (
        <ErrorBanner
          banner={state.banner}
          onDismiss={onDismissBanner}
          onOpenSettings={onOpenSettings}
          onNewChat={() => {
            void onNewChat()
          }}
        />
      )}
      {notice}

      <form
        className="composer"
        onSubmit={(event) => {
          void send(event)
        }}
      >
        <textarea
          aria-label="Message"
          placeholder="Type a message…"
          rows={2}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        {state.running ? (
          <button
            type="button"
            className="button-danger"
            onClick={() => {
              void onStop()
            }}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="button-primary"
            disabled={!draft.trim() || sending || state.switching}
          >
            Send
          </button>
        )}
      </form>
    </div>
  )
}
