import { useEffect, useRef, useState, type SubmitEvent } from 'react'
import type { AppInfo } from '../../shared/ipc'

interface Message {
  id: number
  role: 'user' | 'assistant'
  text: string
}

const WELCOME: Message = {
  id: 0,
  role: 'assistant',
  text: 'Hi! The agent is not connected yet. This is a placeholder chat UI.',
}

export function App(): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([WELCOME])
  const [draft, setDraft] = useState('')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const listEnd = useRef<HTMLLIElement>(null)

  useEffect(() => {
    window.desktopApi.getAppInfo().then(setAppInfo, (error: unknown) => {
      console.error('getAppInfo failed', error)
    })
  }, [])

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  function send(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setMessages((current) => [...current, { id: current.length, role: 'user', text }])
    setDraft('')
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Desktop Agent</h1>
        <span className="app-version">{appInfo ? `v${appInfo.version}` : '…'}</span>
      </header>

      <ol className="messages" aria-label="Messages" aria-live="polite">
        {messages.map((message) => (
          <li key={message.id} className={`message message-${message.role}`}>
            {message.text}
          </li>
        ))}
        <li ref={listEnd} aria-hidden="true" />
      </ol>

      <form className="composer" onSubmit={send}>
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
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
