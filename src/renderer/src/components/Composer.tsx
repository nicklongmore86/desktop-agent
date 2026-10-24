import { useEffect } from 'react'
import type { ProviderStatus } from '../../../shared/ipc'
import {
  CHATGPT_PLAN,
  type ConnectionId,
  type ConnectionInfo,
} from '../../../shared/ipc-connections'
import type { AttachmentsControl } from '../attachments/use-attachments'
import type { OpenSettings } from '../open-settings'
import type { ProviderModelPicker } from '../provider-models'
import { summarizeUsage, type ProviderUsage } from '../usage'
import { StagedChips } from './AttachmentChips'
import { useComposerReferences } from './files/use-composer-references'
import { useToast } from './Toast'
import { ManageUsageLink } from './chatgpt-plan/ManageUsageLink'

export interface ComposerProps {
  draft: string
  onDraft: (text: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  running: boolean
  switching: boolean
  sending: boolean
  onSubmit: () => void
  onStop: () => void
  provider: ProviderStatus | null
  connections: ConnectionInfo[]
  onSwitchProvider: (provider: ConnectionId) => void
  /** The picker's last item: opens the Add connection flow. */
  onManageConnections: () => void
  models: ProviderModelPicker
  usage: ProviderUsage
  onOpenSettings: OpenSettings
  /** Files waiting to be sent with the message. */
  attach: AttachmentsControl
  /** Set to this composer's way of putting text at the caret (for `@` references from attachments). */
  insertRef: React.RefObject<(text: string) => void>
}

const DEFAULT_MODEL = ''
/** Not a connection id (ids never contain an underscore), so it can't be mistaken for one. */
const MANAGE = '_manage'

/** The rounded message box: text, provider and model pickers, usage, and Send/Stop. */
export function Composer({
  draft,
  onDraft,
  inputRef,
  running,
  switching,
  sending,
  onSubmit,
  onStop,
  provider,
  connections,
  onSwitchProvider,
  onManageConnections,
  models,
  usage,
  onOpenSettings,
  attach,
  insertRef,
}: ComposerProps): React.JSX.Element {
  const notify = useToast()
  const summary = summarizeUsage(usage.allowance)
  const { choice } = models
  // File references: the `@` menu, drops from the Files tree, "Insert reference into chat".
  const references = useComposerReferences({ draft, onDraft, inputRef })
  useEffect(() => {
    insertRef.current = references.insertText
  })
  const canSend = (draft.trim() !== '' || attach.staged.length > 0) && !sending && !switching

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {references.menu}
      <StagedChips
        staged={attach.staged}
        connection={provider?.provider ?? null}
        onRemove={attach.remove}
        onCopyIntoFolder={attach.copyIntoFolder}
      />
      <textarea
        {...references.textareaProps}
        ref={inputRef}
        aria-label="Message"
        placeholder="Ask about your files…"
        rows={2}
        value={draft}
        onChange={(event) => {
          onDraft(event.target.value)
          references.onInput(event.target)
        }}
        onPaste={(event) => {
          if (attach.paste(event.clipboardData)) event.preventDefault()
        }}
        onKeyDown={(event) => {
          if (references.onKeyDown(event)) return
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <div className="composer-bar">
        <button
          type="button"
          className="composer-attach"
          aria-label="Attach files"
          title="Attach files"
          disabled={attach.disabled}
          onClick={() => {
            void attach.pick()
          }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="M13 7.5l-4.9 4.9a3 3 0 0 1-4.2-4.2l5.3-5.3a2 2 0 0 1 2.8 2.8L6.7 11a1 1 0 0 1-1.4-1.4L10 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="composer-pickers">
          <select
            className="composer-select"
            aria-label="Active provider"
            value={provider?.provider ?? ''}
            disabled={!provider || switching}
            onChange={(event) => {
              if (event.target.value === MANAGE) onManageConnections()
              else onSwitchProvider(event.target.value)
            }}
          >
            {!provider && <option value="">Loading…</option>}
            {connections
              .toSorted((a, b) => a.pickerOrder - b.pickerOrder)
              .map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            <option value={MANAGE}>Add or manage connections…</option>
          </select>
          {choice && (
            <select
              className="composer-select"
              aria-label="Model"
              value={choice.selected ?? DEFAULT_MODEL}
              disabled={switching}
              onChange={(event) => {
                void models.select(event.target.value || null).then((saved) => {
                  if (!saved) notify('Could not change the model')
                })
              }}
            >
              {connections.find((connection) => connection.id === choice.provider)?.capabilities
                .listsModels && <option value={DEFAULT_MODEL}>Default model</option>}
              {choice.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          {choice?.note && <span className="composer-note">{choice.note}</span>}
          {provider?.provider === CHATGPT_PLAN && provider.state !== 'signed-out' && (
            <span className="plan-label">
              <span>Using ChatGPT plan</span>
              <ManageUsageLink />
            </span>
          )}
          {summary && (
            <button
              type="button"
              className={`usage-chip usage-${summary.level}`}
              title={summary.detail}
              aria-label={`${summary.detail}. Open account settings.`}
              onClick={() => {
                onOpenSettings('accounts')
              }}
            >
              {summary.text}
            </button>
          )}
        </div>
        {running ? (
          <button
            type="button"
            className="composer-send button-danger"
            aria-label="Stop"
            title="Stop (Esc)"
            onClick={onStop}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className="composer-send button-primary"
            aria-label="Send"
            title="Send (Enter)"
            disabled={!canSend}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path
                d="M8 13V3M3.5 7.5L8 3l4.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </form>
  )
}
