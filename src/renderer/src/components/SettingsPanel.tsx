import { useId, useState, type SubmitEvent } from 'react'
import type {
  ApiKeyStatus,
  AuditStatus,
  GrantsState,
  ModelSettings,
  ProviderStatus,
  ProviderId,
} from '../../../shared/ipc'
import { useApi } from '../api'

export interface SettingsPanelProps {
  provider?: ProviderStatus | null | undefined
  onProvider?: ((status: ProviderStatus) => void) | undefined
  keyStatus: ApiKeyStatus | null
  onKeyStatus: (status: ApiKeyStatus) => void
  grants: GrantsState | null
  onGrants: (grants: GrantsState) => void
  model: ModelSettings | null
  onModel: (model: ModelSettings) => void
  audit: AuditStatus | null
}

function ApiKeySection({
  keyStatus,
  onKeyStatus,
}: Pick<SettingsPanelProps, 'keyStatus' | 'onKeyStatus'>): React.JSX.Element {
  const api = useApi()
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const saved = keyStatus?.saved ?? false
  const showInput = !saved || editing

  const run = async (operation: () => Promise<ApiKeyStatus>): Promise<void> => {
    setBusy(true)
    try {
      const status = await operation()
      onKeyStatus(status)
      if (!status.error) {
        setDraft('')
        setEditing(false)
      }
    } catch {
      onKeyStatus({ saved, error: 'The request failed. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!draft.trim()) return
    void run(() => api.apiKey.set(draft))
  }

  return (
    <section className="settings-section" aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`}>Anthropic API key</h3>
      <p className="settings-status" role="status">
        {saved ? 'Key saved.' : 'No key saved.'}
      </p>
      {keyStatus?.error && (
        <p className="settings-error" role="alert">
          {keyStatus.error}
        </p>
      )}
      {showInput ? (
        <form className="settings-row" onSubmit={save}>
          <label htmlFor={inputId} className="visually-hidden">
            API key
          </label>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
          />
          <button type="submit" className="button-primary" disabled={busy || !draft.trim()}>
            {saved ? 'Replace key' : 'Save key'}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setDraft('')
              }}
            >
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="settings-row">
          <button
            type="button"
            onClick={() => {
              setEditing(true)
            }}
          >
            Replace key
          </button>
          <button
            type="button"
            className="button-danger"
            disabled={busy}
            onClick={() => {
              void run(() => api.apiKey.clear())
            }}
          >
            Clear key
          </button>
        </div>
      )}
      <p className="settings-hint">
        The key is encrypted with your operating system&apos;s key store and never shown again.
      </p>
    </section>
  )
}

function GrantsSection({
  grants,
  onGrants,
}: Pick<SettingsPanelProps, 'grants' | 'onGrants'>): React.JSX.Element {
  const api = useApi()
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const roots = grants?.roots ?? []

  const add = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await api.grants.add()
      onGrants(result.grants)
      if (result.status === 'refused') setMessage(result.reason)
    } catch {
      setMessage('Could not add the folder.')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (root: string): Promise<void> => {
    try {
      onGrants(await api.grants.remove(root))
    } catch {
      setMessage('Could not remove the folder.')
    }
  }

  return (
    <section className="settings-section" aria-labelledby="grants-title">
      <h3 id="grants-title">Granted folders</h3>
      <p className="settings-hint">
        The agent can only see and change files inside these folders, and asks before every change.
      </p>
      {grants?.loadError && (
        <p className="settings-error" role="alert">
          {grants.loadError}
        </p>
      )}
      {message && (
        <p className="settings-error" role="alert">
          {message}
        </p>
      )}
      {roots.length === 0 ? (
        <p className="settings-status">No folders granted yet.</p>
      ) : (
        <ul className="grant-list" aria-label="Granted folders">
          {roots.map((root) => (
            <li key={root}>
              <code>{root}</code>
              <button
                type="button"
                aria-label={`Remove ${root}`}
                onClick={() => {
                  void remove(root)
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="button-primary"
        disabled={busy}
        onClick={() => {
          void add()
        }}
      >
        Add folder…
      </button>
    </section>
  )
}

function ModelSection({
  model,
  onModel,
}: Pick<SettingsPanelProps, 'model' | 'onModel'>): React.JSX.Element {
  const api = useApi()
  const selectId = useId()
  const [error, setError] = useState<string | null>(null)
  if (!model) return <section className="settings-section">Loading…</section>
  return (
    <section className="settings-section">
      <h3>
        <label htmlFor={selectId}>Model</label>
      </h3>
      <select
        id={selectId}
        value={model.model}
        onChange={(event) => {
          setError(null)
          api.model.set(event.target.value).then(onModel, () => {
            setError('Could not change the model.')
          })
        }}
      >
        {model.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
            {option.id === model.defaultModel ? ' (default)' : ''}
          </option>
        ))}
      </select>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

export function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  return (
    <div className="settings" aria-label="Settings">
      <h2>Settings</h2>
      <ProviderSection provider={props.provider} onProvider={props.onProvider} />
      {(!props.provider || props.provider.provider === 'anthropic-api') && (
        <ApiKeySection keyStatus={props.keyStatus} onKeyStatus={props.onKeyStatus} />
      )}
      <GrantsSection grants={props.grants} onGrants={props.onGrants} />
      {(!props.provider || props.provider.provider === 'anthropic-api') && (
        <ModelSection model={props.model} onModel={props.onModel} />
      )}
      <section className="settings-section">
        <h3>Audit log</h3>
        <p className="settings-hint">Every tool call is recorded here:</p>
        <code className="audit-path">{props.audit?.path ?? '…'}</code>
        {props.audit && !props.audit.healthy && (
          <p className="settings-error" role="alert">
            Writing the audit log is failing.
          </p>
        )}
      </section>
    </div>
  )
}

function ProviderSection({
  provider,
  onProvider,
}: Pick<SettingsPanelProps, 'provider' | 'onProvider'>): React.JSX.Element {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (operation: () => Promise<ProviderStatus>) => {
    setBusy(true)
    setError(null)
    try {
      onProvider?.(await operation())
    } catch {
      setError('Provider request failed. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="settings-section">
      <h3>
        <label htmlFor="provider-select">Access provider</label>
      </h3>
      <select
        id="provider-select"
        value={provider?.provider ?? 'anthropic-api'}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value as ProviderId
          void run(() => api.provider.set(next))
        }}
      >
        <option value="anthropic-api">Anthropic API</option>
        <option value="claude-subscription">Claude subscription</option>
        <option value="codex-subscription">Codex subscription (ChatGPT)</option>
      </select>
      <p role="status">{provider?.message ?? 'Loading provider…'}</p>
      {error && <p role="alert">{error}</p>}
      {provider && provider.provider !== 'anthropic-api' && (
        <>
          <p>
            No API key required. Install the supported official runtime, then sign in here. Each
            provider has separate chat history. Switching stops the current reply.
          </p>
          <p>
            Required runtime:{' '}
            {provider.provider === 'claude-subscription'
              ? 'Claude Code 2.1.299'
              : 'Codex CLI 0.162.1'}
            . See the README for Windows installation steps.
          </p>
          <button
            disabled={busy}
            onClick={() => {
              void run(() => api.provider.get())
            }}
          >
            Check readiness
          </button>
          <button
            disabled={busy}
            onClick={() => {
              void run(() => api.provider.login())
            }}
          >
            Sign in with subscription
          </button>
          {busy && (
            <button
              onClick={() => {
                void api.provider.cancelLogin()
              }}
            >
              Cancel sign-in
            </button>
          )}
        </>
      )}
    </section>
  )
}
