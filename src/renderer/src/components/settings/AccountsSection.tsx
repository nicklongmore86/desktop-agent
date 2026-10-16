import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type RefObject,
  type SubmitEvent,
} from 'react'
import type { ApiKeyStatus, ProviderLoginState, ProviderStatus } from '../../../../shared/ipc'
import { useApi } from '../../api'
import { UsageSection } from './UsageSection'

import { useProviderModels } from '../../provider-models'
import type { SettingsPanelProps } from '../SettingsPanel'
export function ApiKeySection({
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
            Remove key
          </button>
        </div>
      )}
      <p className="settings-hint">
        The key is encrypted by Windows and can&apos;t be viewed again.
      </p>
    </section>
  )
}

function ModelSection(): React.JSX.Element {
  const selectId = useId()
  const [error, setError] = useState<string | null>(null)
  const models = useProviderModels('anthropic-api')
  const choice = models.choice
  if (!choice) return <section className="settings-section">Loading…</section>
  return (
    <section className="settings-section">
      <h3>
        <label htmlFor={selectId}>Model</label>
      </h3>
      <select
        id={selectId}
        value={choice.selected ?? ''}
        onChange={(event) => {
          setError(null)
          void models.select(event.target.value).then((saved) => {
            if (!saved) setError('Could not change the model.')
          })
        }}
      >
        {choice.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
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
        Your browser should have opened. If it didn&apos;t, use the link below, then paste the code
        you&apos;re shown.
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

export function ProviderSection({
  provider,
  onProvider,
  onSwitchProvider,
}: Pick<SettingsPanelProps, 'provider' | 'onProvider' | 'onSwitchProvider'>): React.JSX.Element {
  const api = useApi()
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
  useEffect(() => {
    let live = true
    api.provider.get().then(
      (status) => {
        if (live && status.provider === current) reportResult(status)
      },
      () => {
        if (live) setError('Provider request failed. Try again.')
      },
    )
    return () => {
      live = false
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
      <h3>Accounts &amp; providers</h3>
      <div role="radiogroup" aria-label="Access provider" className="provider-cards">
        {(
          [
            [
              'claude-subscription',
              'Claude · Subscription',
              'Sign in with your Claude account. No API key needed.',
            ],
            [
              'codex-subscription',
              'Codex · ChatGPT',
              'Sign in with your ChatGPT account. No API key needed.',
            ],
            ['anthropic-api', 'Anthropic API', 'Use your own API key.'],
          ] as const
        ).map(([id, title, description]) => (
          <label className="provider-card" key={id}>
            <input
              type="radio"
              name="provider"
              value={id}
              checked={(current ?? 'anthropic-api') === id}
              disabled={busy}
              onChange={() => {
                void run(() => onSwitchProvider(id))
              }}
            />
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        Each provider keeps its own chat history. Switching provider ends the current reply.
      </p>
      {waiting ? (
        <p className="settings-status" role="status">
          Waiting for sign-in…
        </p>
      ) : provider?.state === 'error' ? (
        <p className="settings-error" role="alert">
          {provider.message}
        </p>
      ) : (
        <p role="status">
          {provider?.signedIn || provider?.state === 'ready' || provider?.state === 'limited'
            ? 'Connected'
            : provider?.state === 'missing-runtime'
              ? `Can’t start ${provider.provider === 'claude-subscription' ? 'Claude Code' : 'Codex'}`
              : provider?.state === 'signed-out'
                ? 'Not signed in'
                : (provider?.message ?? 'Loading provider…')}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {(provider?.state === 'error' || provider?.state === 'missing-runtime' || error) && (
        <button
          className="settings-retry"
          disabled={busy}
          onClick={() => {
            void run(() => api.provider.get())
          }}
        >
          Retry
        </button>
      )}
      {provider && provider.provider !== 'anthropic-api' && (
        <>
          <button
            disabled={busy || login.active}
            onClick={() => {
              void signIn()
            }}
          >
            Sign in
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

export function AccountsSection(props: SettingsPanelProps): React.JSX.Element {
  return (
    <>
      <ProviderSection
        provider={props.provider}
        onProvider={props.onProvider}
        onSwitchProvider={props.onSwitchProvider}
      />
      {!props.provider || props.provider.provider === 'anthropic-api' ? (
        <>
          <ApiKeySection keyStatus={props.keyStatus} onKeyStatus={props.onKeyStatus} />
          <ModelSection />
        </>
      ) : (
        <UsageSection key={props.provider.provider} provider={props.provider.provider} />
      )}
    </>
  )
}
