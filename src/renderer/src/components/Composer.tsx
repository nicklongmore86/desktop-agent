import type { ProviderId, ProviderStatus } from '../../../shared/ipc'
import type { OpenSettings } from '../open-settings'
import type { ProviderModelPicker } from '../provider-models'
import { summarizeUsage, type ProviderUsage } from '../usage'
import { useToast } from './Toast'

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
  providerNames: Record<ProviderId, string>
  onSwitchProvider: (provider: ProviderId) => void
  models: ProviderModelPicker
  usage: ProviderUsage
  onOpenSettings: OpenSettings
}

const DEFAULT_MODEL = ''

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
  providerNames,
  onSwitchProvider,
  models,
  usage,
  onOpenSettings,
}: ComposerProps): React.JSX.Element {
  const notify = useToast()
  const summary = summarizeUsage(usage.allowance)
  const { choice } = models

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <textarea
        ref={inputRef}
        aria-label="Message"
        placeholder="Ask about your files…"
        rows={2}
        value={draft}
        onChange={(event) => {
          onDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-pickers">
          <select
            className="composer-select"
            aria-label="Active provider"
            value={provider?.provider ?? ''}
            disabled={!provider || switching}
            onChange={(event) => {
              onSwitchProvider(event.target.value as ProviderId)
            }}
          >
            {!provider && <option value="">Loading…</option>}
            {Object.entries(providerNames).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
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
              {choice.provider !== 'anthropic-api' && (
                <option value={DEFAULT_MODEL}>Default model</option>
              )}
              {choice.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          {choice?.note && <span className="composer-note">{choice.note}</span>}
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
            disabled={!draft.trim() || sending || switching}
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
