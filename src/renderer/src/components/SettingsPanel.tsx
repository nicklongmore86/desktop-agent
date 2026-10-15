import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type RefObject,
  type SubmitEvent,
} from 'react'
import type {
  ApiKeyStatus,
  AuditStatus,
  GrantsState,
  ModelSettings,
  ProviderLoginState,
  ProviderStatus,
  ProviderId,
} from '../../../shared/ipc'
import { useApi } from '../api'

export interface SettingsPanelProps {
  provider?: ProviderStatus | null | undefined
  onProvider?: ((status: ProviderStatus) => void) | undefined
  /** Switches provider; the chat uses it to hide the old conversation meanwhile. */
  onSwitchProvider?: ((provider: ProviderId) => Promise<ProviderStatus>) | undefined
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
      <ProviderSection
        provider={props.provider}
        onProvider={props.onProvider}
        onSwitchProvider={props.onSwitchProvider}
      />
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

/** Claude prints `<code>#<state>`; main checks it again before passing it on. */
const LOGIN_CODE = /^[^#\s]+#[^#\s]+$/

/** False once the component has unmounted, so late replies never set its state. */
function useMounted(): RefObject<boolean> {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}

function LoginLink({ url }: { url: string }): React.JSX.Element {
  const api = useApi()
  const linkId = useId()
  const codeId = useId()
  const mounted = useMounted()
  const [code, setCode] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = (operation: () => Promise<void>, done: string, failed: string) => {
    setError(null)
    setNote(null)
    operation().then(
      () => {
        if (mounted.current) setNote(done)
      },
      () => {
        if (mounted.current) setError(failed)
      },
    )
  }
  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setError(null)
    setNote(null)
    const value = code.trim()
    if (!LOGIN_CODE.test(value)) {
      setError('That does not look like a sign-in code. Copy the whole code.')
      return
    }
    api.provider.submitLoginCode(value).then(
      (result) => {
        if (!mounted.current) return
        if (result.ok) {
          setCode('')
          setNote('Code sent. Finishing sign-in…')
        } else setError(result.error)
      },
      () => {
        if (mounted.current) setError('Could not send the code. Try again.')
      },
    )
  }
  return (
    <div className="login-link">
      <p className="settings-hint">
        Your browser should open to sign in. If it did not, open or copy this link, then paste the
        code shown after you authorize.
      </p>
      <label htmlFor={linkId}>Sign-in link</label>
      <div className="settings-row">
        <input
          id={linkId}
          type="text"
          readOnly
          value={url}
          spellCheck={false}
          onFocus={(event) => {
            event.target.select()
          }}
        />
        <button
          type="button"
          onClick={() => {
            request(() => api.provider.copyLoginUrl(), 'Link copied.', 'Could not copy the link.')
          }}
        >
          Copy
        </button>
        <button
          type="button"
          onClick={() => {
            request(
              () => api.provider.openLoginUrl(),
              'Opened in your browser.',
              'Could not open the browser. Copy the link instead.',
            )
          }}
        >
          Open in browser
        </button>
      </div>
      <form className="settings-row" onSubmit={submit}>
        <label htmlFor={codeId} className="visually-hidden">
          Paste code
        </label>
        <input
          id={codeId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value)
          }}
        />
        <button type="submit" disabled={!code.trim()}>
          Submit code
        </button>
      </form>
      {note && <p className="settings-hint">{note}</p>}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function ProviderSection({
  provider,
  onProvider,
  onSwitchProvider,
}: Pick<SettingsPanelProps, 'provider' | 'onProvider' | 'onSwitchProvider'>): React.JSX.Element {
  const api = useApi()
  const switchProvider = onSwitchProvider ?? ((next: ProviderId) => api.provider.set(next))
  const mounted = useMounted()
  const [busy, setBusy] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  /** Main's sign-in for this provider; survives Settings being closed and reopened. */
  const [login, setLogin] = useState<{ active: boolean; url: string | null }>({
    active: false,
    url: null,
  })
  const [error, setError] = useState<string | null>(null)
  const current = provider?.provider
  const reportResult = useEffectEvent((status: ProviderStatus) => {
    onProvider?.(status)
  })
  useEffect(() => {
    let live = true
    const apply = (state: ProviderLoginState) => {
      if (!live) return
      // Another provider's sign-in is not this one's to show.
      if (state.active && state.provider === current) {
        setLogin({ active: true, url: state.url })
        return
      }
      setLogin({ active: false, url: null })
      if (state.result && state.result.provider === current) reportResult(state.result)
    }
    const unsubscribe = api.onProviderLoginState(apply)
    api.provider.loginState().then(apply, () => {})
    return () => {
      live = false
      unsubscribe()
    }
  }, [api, current])
  const run = async (operation: () => Promise<ProviderStatus>) => {
    setBusy(true)
    setError(null)
    try {
      const status = await operation()
      // The app keeps the status even if Settings was closed meanwhile.
      onProvider?.(status)
    } catch {
      if (mounted.current) setError('Provider request failed. Try again.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const signIn = async () => {
    setSigningIn(true)
    try {
      await run(() => api.provider.login())
    } finally {
      if (mounted.current) setSigningIn(false)
    }
  }
  const waiting = signingIn || login.active
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
          void run(() => switchProvider(next))
        }}
      >
        <option value="anthropic-api">Anthropic API</option>
        <option value="claude-subscription">Claude subscription</option>
        <option value="codex-subscription">Codex subscription (ChatGPT)</option>
      </select>
      {waiting ? (
        <p className="settings-status" role="status">
          Waiting for sign-in…
        </p>
      ) : provider?.state === 'error' ? (
        <p className="settings-error" role="alert">
          {provider.message}
        </p>
      ) : (
        <p role="status">{provider?.message ?? 'Loading provider…'}</p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {provider && provider.provider !== 'anthropic-api' && (
        <>
          <p>
            No API key required. The Windows x64 installer includes both runtimes. Sign in here.
            Each provider has separate chat history. Switching stops the current reply.
          </p>
          <p>
            Required runtime:{' '}
            {provider.provider === 'claude-subscription'
              ? 'Claude Code 2.1.299'
              : 'Codex CLI 0.162.1'}
            . If a bundled runtime is missing, repair or reinstall Desktop Agent. See the README.
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
            disabled={busy || login.active}
            onClick={() => {
              void signIn()
            }}
          >
            Sign in with subscription
          </button>
          {(busy || login.active) && (
            <button
              onClick={() => {
                void api.provider.cancelLogin()
              }}
            >
              Cancel sign-in
            </button>
          )}
          {waiting && login.url && <LoginLink url={login.url} />}
        </>
      )}
    </section>
  )
}
