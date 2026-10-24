import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProviderStatus } from '../../../shared/ipc'
import {
  CHATGPT_PLAN,
  type ConnectionId,
  type ConnectionInfo,
} from '../../../shared/ipc-connections'
import type { ChatAttachment } from '../../../shared/ipc'
import { canReceive, notReceivedNote } from '../attachments/model'
import { useHeicSupport } from '../attachments/use-heic'
import { useConnectionVision } from '../attachments/use-vision'
import { useAttachments } from '../attachments/use-attachments'
import type { ChatViewState } from '../chat-state'
import type { OpenSettings } from '../open-settings'
import { useProviderModels } from '../provider-models'
import { splitTurns } from '../turns'
import { useProviderUsage } from '../usage'
import { ActivityGroup } from './ActivityGroup'
import { AttachmentChip } from './AttachmentChips'
import { CommandCard } from './CommandCard'
import { Composer } from './Composer'
import { ErrorBanner } from './ErrorBanner'
import { useExternalFileDrop } from './files/external-drop'
import { Markdown } from './Markdown'
import { MessageActions } from './MessageActions'
import { PromptRail } from './PromptRail'
import { WorkFold } from './WorkFold'

export interface ChatViewProps {
  providerName: string
  grantedFolders: number
  state: ChatViewState
  onSend: (text: string, attachmentIds?: string[]) => Promise<boolean>
  onStop: () => Promise<void>
  onNewChat: () => Promise<void>
  onDismissBanner: () => void
  onDismissStorageWarning: () => void
  onOpenSettings: OpenSettings
  /** The selected provider, or null until it has loaded. */
  provider: ProviderStatus | null
  /** Display names of every provider, for the composer's picker. */
  /** The connections to offer, from main's registry. */
  connections: ConnectionInfo[]
  /** Switches provider through the same path as Settings (clears the conversation). */
  onSwitchProvider: (provider: ConnectionId) => Promise<void>
  /** Opens the Add connection flow (the picker's last item). */
  onManageConnections: () => void
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
  connections,
  onSwitchProvider,
  onManageConnections,
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
  const vision = useConnectionVision(provider?.provider, models.choice?.selected)?.enabled === true
  const heic = useHeicSupport()
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
  // A layout effect, so Esc works from the commit that shows Stop: a passive effect can run a
  // task later, and an Esc pressed in between was lost.
  const approvalOpen = state.approvals.length > 0
  const running = state.running
  useLayoutEffect(() => {
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

  // Sending is blocked while a reply runs, so attaching is too. Approvals are never affected:
  // they are answered in their own dialog, and nothing here handles Esc.
  const insertRef = useRef<(text: string) => void>(() => {})
  const insertText = useCallback((text: string) => {
    insertRef.current(text)
  }, [])
  const attach = useAttachments({ insertText, onOpenSettings, disabled: busy })
  const externalDrop = useExternalFileDrop({ onFiles: (files) => void attach.attachFiles(files) })
  const clearAttachments = attach.clear

  const submit = async (
    text: string,
    clearDraft: boolean,
    attachmentIds: string[] = [],
  ): Promise<void> => {
    if ((!text && attachmentIds.length === 0) || busy) return
    setSending(true)
    try {
      if (await onSend(text, attachmentIds)) {
        if (clearDraft) {
          setDraft('')
          clearAttachments()
        }
      }
    } finally {
      setSending(false)
    }
  }

  const retryFor = (
    text: string,
    attachments: readonly ChatAttachment[] = [],
  ): { onRetry: () => void; retryDisabled: boolean } => ({
    onRetry: () => {
      void submit(
        text,
        false,
        attachments.filter((a) => a.available).map((a) => a.id),
      )
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
    <div className="chat" {...externalDrop.zoneProps}>
      {externalDrop.hint}
      {/* Keyed by conversation: another chat starts with fresh scroll-spy, preview and flash
          state, even when it has as many prompts as the last one. */}
      <PromptRail
        key={state.history.activeId ?? ''}
        prompts={prompts}
        scrollRef={messagesRef}
        disabled={approvalOpen}
      />
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
                  {turn.user.attachments && turn.user.attachments.length > 0 && (
                    <ul className="attachment-chips" aria-label="Attached files">
                      {turn.user.attachments.map((attachment) => (
                        <AttachmentChip
                          key={attachment.id}
                          attachment={attachment}
                          available={attachment.available}
                          unsupported={!canReceive(attachment.kind, vision, attachment.mime, heic)}
                          unsupportedNote={notReceivedNote(
                            attachment.kind,
                            vision,
                            attachment.mime,
                            heic,
                          )}
                        />
                      ))}
                    </ul>
                  )}
                  {turn.user.text && <div className="message-body">{turn.user.text}</div>}
                  <MessageActions
                    text={turn.user.text}
                    {...(turn.user === lastMessage && lastUser
                      ? retryFor(lastUser.text, lastUser.attachments)
                      : {})}
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
                      {...(item === lastMessage && lastUser
                        ? retryFor(lastUser.text, lastUser.attachments)
                        : {})}
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
          manageUsage={provider?.provider === CHATGPT_PLAN}
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
          attach={attach}
          vision={vision}
          insertRef={insertRef}
          onSubmit={() => {
            void submit(draft.trim(), true, attach.ids)
          }}
          onStop={() => {
            void onStop()
          }}
          provider={provider}
          connections={connections}
          onManageConnections={onManageConnections}
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
