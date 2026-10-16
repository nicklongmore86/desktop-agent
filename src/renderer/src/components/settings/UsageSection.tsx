import { useId, useState } from 'react'
import type { ProviderId } from '../../../../shared/ipc'
import { useProviderModels } from '../../provider-models'
import {
  formatReset,
  summarizeUsage,
  usageLevel,
  usedPercent,
  useProviderUsage,
  windowName,
} from '../../usage'

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Plan, limits and (for Codex) the model; reads through the same hooks as the chat indicator. */
export function UsageSection({ provider }: { provider: ProviderId }): React.JSX.Element {
  const modelId = useId()
  const [modelError, setModelError] = useState<string | null>(null)
  const usage = useProviderUsage(provider)
  const models = useProviderModels(provider)
  const { allowance } = usage
  const summary = summarizeUsage(allowance)
  const level = usageLevel(allowance)
  const resetsAt = formatReset(allowance?.resetsAt)
  const choice = models.choice
  return (
    <section className="settings-section">
      <div className="settings-row">
        <h3>Usage</h3>
        <button
          type="button"
          onClick={() => {
            setModelError(null)
            usage.refresh()
            models.refresh()
          }}
        >
          Refresh
        </button>
      </div>
      <p>{allowance?.plan ?? 'Plan unavailable'}</p>
      <p role="status">
        {allowance?.state === 'limited'
          ? `Limit reached${resetsAt ? ` — resets ${resetsAt}` : ''}`
          : allowance?.state === 'available'
            ? 'Available'
            : 'Usage unavailable right now'}
      </p>
      {allowance?.credits && (
        <p>
          {allowance.credits.unlimited
            ? 'Unlimited credits'
            : allowance.credits.hasCredits
              ? 'Credits available'
              : 'No credits available'}
        </p>
      )}
      {provider === 'claude-subscription' ? (
        <p className="settings-hint">
          Last known limit state. Claude does not report usage percentages.
        </p>
      ) : (
        <>
          {summary && summary.level !== 'limited' && summary.text && (
            <p className={level === 'ok' ? undefined : `usage-${level}`}>{summary.detail}</p>
          )}
          {allowance?.windows.map((window) => {
            const used = usedPercent(window.remainingPercent)
            const reset = formatReset(window.resetsAt)
            return (
              <div
                key={window.limitId}
                className={used >= 100 ? 'usage-limited' : used >= 80 ? 'usage-warning' : ''}
              >
                <p>
                  {capitalize(windowName(window.limitId))} · {used}% used
                </p>
                <progress aria-label={`${window.limitId} usage`} max={100} value={used} />
                {reset && <p className="settings-hint">Resets {reset}</p>}
              </div>
            )
          })}
        </>
      )}
      {provider === 'codex-subscription' && (
        <>
          <label htmlFor={modelId}>Codex model</label>
          <select
            id={modelId}
            disabled={!choice}
            value={choice?.selected ?? ''}
            onChange={(event) => {
              setModelError(null)
              void models.select(event.target.value || null).then((saved) => {
                if (!saved) setModelError('Could not change the model.')
              })
            }}
          >
            <option value="">Account default</option>
            {choice?.options.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          {modelError && (
            <p className="settings-error" role="alert">
              {modelError}
            </p>
          )}
          {choice?.note && <p className="settings-hint">{choice.note}</p>}
        </>
      )}
    </section>
  )
}
