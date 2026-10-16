import { useEffect, useRef, useState } from 'react'
import type { ProviderAllowance, ProviderId, ProviderModels } from '../../../../shared/ipc'
import { useApi } from '../../api'

function resetTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    ...(date.toDateString() === new Date().toDateString()
      ? {}
      : { weekday: 'short' as const, month: 'short' as const, day: 'numeric' as const }),
    hour: 'numeric',
    minute: '2-digit',
  })
}
export function UsageSection({ provider }: { provider: ProviderId }): React.JSX.Element {
  const api = useApi()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [saving, setSaving] = useState(false)
  const [usage, setUsage] = useState<ProviderAllowance | null>(null)
  const [models, setModels] = useState<ProviderModels | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    api.provider.allowance().then(
      (result) => {
        if (!live) return
        if (result.ok && result.value.provider !== provider) return
        if (result.ok) {
          setUsage(result.value)
          setError(null)
        } else {
          setUsage(null)
          setError(result.failure.message)
        }
      },
      () => {
        if (live) {
          setUsage(null)
          setError('Usage unavailable right now')
        }
      },
    )
    if (provider === 'codex-subscription')
      api.provider.models().then(
        (result) => {
          if (!live || (result.ok && result.value.provider !== provider)) return
          if (result.ok) {
            setModels(result.value)
            setModelError(null)
          } else {
            setModels(null)
            setModelError(result.failure.message)
          }
        },
        () => {
          if (live) {
            setModels(null)
            setModelError('Could not load models. Refresh to try again.')
          }
        },
      )
    return () => {
      live = false
    }
  }, [api, provider, refresh])
  return (
    <section className="settings-section">
      <div className="settings-row">
        <h3>Usage</h3>
        <button
          onClick={() => {
            setRefresh((value) => value + 1)
          }}
        >
          Refresh
        </button>
      </div>
      <p>{usage?.plan ?? 'Plan unavailable'}</p>
      <p role="status">
        {usage?.state === 'available'
          ? 'Available'
          : usage?.state === 'limited'
            ? `Limit reached${usage.resetsAt ? ` — resets ${resetTime(usage.resetsAt)}` : ''}`
            : 'Usage unavailable right now'}
      </p>
      {usage?.credits && (
        <p>
          {usage.credits.unlimited
            ? 'Unlimited credits'
            : usage.credits.hasCredits
              ? 'Credits available'
              : 'No credits available'}
        </p>
      )}
      {error && <p className="settings-hint">{error}</p>}
      {provider === 'claude-subscription' ? (
        <p className="settings-hint">
          Last known limit state. Claude does not report usage percentages.
        </p>
      ) : (
        usage?.windows.map((window) => {
          const used = Math.round(100 - window.remainingPercent)
          return (
            <div
              key={window.limitId}
              className={used >= 100 ? 'usage-limited' : used >= 80 ? 'usage-warning' : ''}
            >
              <p>
                {window.limitId} · {used}% used
              </p>
              <progress aria-label={`${window.limitId} usage`} max={100} value={used} />
              {window.resetsAt && (
                <p className="settings-hint">Resets {resetTime(window.resetsAt)}</p>
              )}
            </div>
          )
        })
      )}
      {provider === 'codex-subscription' && (
        <>
          {modelError && <p className="settings-hint">{modelError}</p>}
          <label htmlFor="codex-model">Codex model</label>
          <select
            id="codex-model"
            disabled={!models || saving}
            value={models?.selectedModel ?? ''}
            onChange={(event) => {
              setSaving(true)
              void api.provider.setModel(event.target.value || null).then(
                (result) => {
                  if (!mounted.current) return
                  setSaving(false)
                  if (result.ok && result.value.provider === provider) {
                    setModels(result.value)
                    setError(null)
                  } else if (!result.ok) setError(result.failure.message)
                },
                () => {
                  if (!mounted.current) return
                  setSaving(false)
                  setError('Could not change the model.')
                },
              )
            }}
          >
            <option value="">Account default</option>
            {models?.options.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          {models && models.resolvedModel !== models.savedModel && (
            <p className="settings-hint">Using default model</p>
          )}
        </>
      )}
    </section>
  )
}
