import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, ProviderStatus } from '../../../shared/ipc'
import type { ChatViewState } from '../chat-state'
import type { OpenSettings } from '../open-settings'
import { useProviderModels } from '../provider-models'
import { splitTurns } from '../turns'
import { useProviderUsage } from '../usage'
import { ActivityGroup } from './ActivityGroup'
import { CommandCard } from './CommandCard'
import { Composer } from './Composer'
import { ErrorBanner } from './ErrorBanner'
import { Markdown } from './Markdown'
import { MessageActions } from './MessageActions'
import { PromptRail } from './PromptRail'
import { WorkFold } from './WorkFold'

export interface ChatViewProps {
  providerName: string
  grantedFolders: number
  state: ChatViewState
  onSend: (text: string) => Promise<boolean>
  onStop: () => Promise<void>
  onNewChat: () => Promise<void>
  onDismissBanner: () => void
  onDismissStorageWarning: () => void
  onOpenSettings: OpenSettings
  /** The selected provider, or null until it has loaded. */
  provider: ProviderStatus | null
  /** Display names of every provider, for the composer's picker. */
  providerNames: Record<ProviderId, string>
  /** Switches provider through the same path as Settings (clears the conversation). */
  onSwitchProvider: (provider: ProviderId) => Promise<void>
  /** Lets the app focus the message box (Ctrl/Cmd+K). */
  composerRef?: React.RefObject<HTMLTextAreaElement | null>
  /** Shown above the composer when setup is incomplete. */
  notice?: React.ReactNode
  /** In Command view: the command bar, shown in place of the composer. */
  commandBar?: React.ReactNode
  /** The OS, for the shell prompt on command cards. */
  platform?: string | undefined
}

export function ChatView({
  state,
  providerName,
  grantedFolders,
  onSend,
  onStop,
  onNewChat,
  onDismissBanner,
  onDismissStorageWarning,
  onOpenSettings,
  provider,
  providerNames,
  onSwitchProvider,
  composerRef,
  notice,
  commandBar,
  platform,
}: ChatViewProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listEnd = useRef<HTMLLIElement>(null)
  const messagesRef = useRef<HTMLOListElement>(null)
  const ownInput = useRef<HTMLTextAreaElement>(null)
  const inputRef = composerRef ?? ownInput

  const usage = useProviderUsage(provider?.provider)
  const models = useProviderModels(provider?.provider)
  const refreshUsage = usage.refresh
  const refreshModels = models.refresh

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' })
  }, [state.items])

  // After each completed turn the allowance and the resolved model have changed.
  const wasRunning = useRef(state.running)
  useEffect(() => {
    if (wasRunning.current && !state.running) {
      refreshUsage()
      refreshModels()
    }
    wasRunning.current = state.running
  }, [state.running, refreshUsage, refreshModels])

  const limitBanner = state.banner?.code === 'usage_limit'
  useEffect(() => {
    if (limitBanner) refreshUsage()
  }, [limitBanner, refreshUsage])

  // Esc stops a running reply, but never while an approval is open: there it denies.
  const approvalOpen = state.approvals.length > 0
  const running = state.running
  useEffect(() => {
    if (!running || approvalOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      void onStop()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [running, approvalOpen, onStop])

  const busy = state.running || state.switching || sending

  const submit = async (text: string, clearDraft: boolean): Promise<void> => {
    if (!text || busy) return
    setSending(true)
    try {
      if ((await onSend(text)) && clearDraft) setDraft('')
    } finally {
      setSending(false)
    }
  }

  const retryFor = (text: string): { onRetry: () => void; retryDisabled: boolean } => ({
    onRetry: () => {
      void submit(text, false)
    },
    retryDisabled: busy,
  })

  const lastUser = state.items.findLast((item) => item.kind === 'user')
  // Retry sits on the last message of the conversation (a reply, or the question without one).
  const lastMessage = state.items.findLast((item) => item.kind !== 'tool')
  const turns = useMemo(() => splitTurns(state.items), [state.items])
  const prompts = useMemo(
    () => state.items.filter((item) => item.kind === 'user').map(({ id, text }) => ({ id, text })),
    [state.items],
  )
  const waitingIds = useMemo(
    () =>
      new Set(
        state.approvals.flatMap((prompt) => (prompt.toolUseId === null ? [] : [prompt.toolUseId])),
      ),
    [state.approvals],
  )

  return (
    <div className="chat">
      <PromptRail prompts={prompts} scrollRef={messagesRef} disabled={approvalOpen} />
      <div className="chat-toolbar">
        <span className="provider-badge">{providerName}</span>
        <span className="folder-count">
          {grantedFolders} {grantedFolders === 1 ? 'folder' : 'folders'} granted
        </span>
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

      <ol className="messages" aria-label="Messages" ref={messagesRef}>
        {state.switching && (
          <li className="messages-empty" role="status">
            Switching provider…
          </li>
        )}
        {state.items.length === 0 && !state.switching && (
          <li className="messages-empty welcome">
            <span className="welcome-eyebrow">YOUR FILES, WITH YOUR PERMISSION</span>
            <h2>What would you like to work on?</h2>
            <p>
              Explore a folder, find a document, or make a change.
              <br />
              You approve every write and command.
            </p>
            <div className="starter-prompts">
              {['Show my granted folders', 'Scan my Downloads folder', 'Help me find a file'].map(
                (text) => (
                  <button
                    type="button"
                    key={text}
                    onClick={() => {
                      setDraft(text)
                      inputRef.current?.focus()
                    }}
                  >
                    {text} ↗
                  </button>
                ),
              )}
            </div>
          </li>
        )}
        {turns.map((turn, turnIndex) => {
          const lastTurn = turnIndex === turns.length - 1
          return (
            <Fragment key={turn.user?.id ?? 'preamble'}>
              {turn.user && (
                <li className="message message-user" data-prompt-id={turn.user.id}>
                  <div className="message-body">{turn.user.text}</div>
                  <MessageActions
                    text={turn.user.text}
                    {...(turn.user === lastMessage && lastUser ? retryFor(lastUser.text) : {})}
                  />
                </li>
              )}
              {turn.entries.map((entry, entryIndex) => {
                // A command the user typed: its own card, never folded into the agent's work.
                if (entry.kind === 'command') {
                  return (
                    <li key={entry.item.id} className="message message-command">
                      <CommandCard
                        item={entry.item}
                        running={state.running}
                        queued={waitingIds.has(entry.item.id)}
                        platform={platform}
                      />
                    </li>
                  )
                }
                if (entry.kind === 'tools') {
                  const live = state.running && lastTurn && entryIndex === turn.entries.length - 1
                  return (
                    <li key={`tools:${entry.tools[0]?.id ?? ''}`} className="message message-tool">
                      {lastTurn ? (
                        <ActivityGroup
                          tools={entry.tools}
                          running={state.running}
                          live={live}
                          waitingIds={waitingIds}
                        />
                      ) : (
                        <WorkFold tools={entry.tools} running={state.running} />
                      )}
                    </li>
                  )
                }
                const { item } = entry
                return (
                  <li key={item.id} className="message message-assistant">
                    <span className="message-author">{providerName}</span>
                    <Markdown text={item.text} />
                    {item.stopped && (
                      <p className="message-note">Stopped. This reply was not saved.</p>
                    )}
                    <MessageActions
                      text={item.text}
                      {...(item === lastMessage && lastUser ? retryFor(lastUser.text) : {})}
                    />
                  </li>
                )
              })}
            </Fragment>
          )
        })}
        {state.running && (
          <li className="message-progress" role="status" aria-live="polite">
            <span className="typing-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>{providerName} is working…</span>
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

      {commandBar && <div className="composer-dock">{commandBar}</div>}
      {/* Kept mounted in Command view, so the message draft survives the switch. */}
      <div className="composer-dock" hidden={commandBar !== undefined}>
        <Composer
          draft={draft}
          onDraft={setDraft}
          inputRef={inputRef}
          running={state.running}
          switching={state.switching}
          sending={sending}
          onSubmit={() => {
            void submit(draft.trim(), true)
          }}
          onStop={() => {
            void onStop()
          }}
          provider={provider}
          providerNames={providerNames}
          onSwitchProvider={(next) => {
            void onSwitchProvider(next)
          }}
          models={models}
          usage={usage}
          onOpenSettings={onOpenSettings}
        />
        <p className="composer-hint">Enter to send · Shift + Enter for a new line · Esc to stop</p>
      </div>
    </div>
  )
}
