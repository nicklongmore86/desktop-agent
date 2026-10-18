import { useEffect, useEffectEvent, useId, useState, type SubmitEvent } from 'react'
import type { ProviderLoginState, ProviderStatus } from '../../../../shared/ipc'
import type { ConnectionInfo } from '../../../../shared/ipc-connections'
import { BaseUrlField } from './BaseUrlField'
import { useMounted } from './use-mounted'
import { plainText } from '../../plain-text'
import { useApi } from '../../api'
import { isConnected } from './flow'

/** Claude prints `<code>#<state>`; main checks it again before passing it on. */
const LOGIN_CODE = /^[^#\s]+#[^#\s]+$/

export function LoginLink({ url }: { url: string }): React.JSX.Element {
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

/**
 * The status line and sign-in controls for the connection chats go to (main's
 * login acts on the current connection): "Connected", "Not signed in", the Sign
 * in / Cancel buttons and, once the runtime has printed it, the link and code
 * panel. For a local server the same line carries main's message and the button
 * is "Check again". It survives its dialog closing and reopening, because main
 * keeps the sign-in running and reports it again.
 */
export function ProviderPanel({
  connection,
  status,
  onStatus,
}: {
  connection: ConnectionInfo
  /** The app's last status for this connection; the parent keeps it. */
  status: ProviderStatus | null
  onStatus: (status: ProviderStatus) => void
}): React.JSX.Element {
  const api = useApi()
  const mounted = useMounted()
  const id = connection.id
  const [busy, setBusy] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  /** Main's sign-in for this connection; survives the dialog being closed and reopened. */
  const [login, setLogin] = useState<{ active: boolean; url: string | null }>({
    active: false,
    url: null,
  })
  const [error, setError] = useState<string | null>(null)
  const report = useEffectEvent((next: ProviderStatus) => {
    onStatus(next)
  })
  useEffect(() => {
    let live = true
    const apply = (state: ProviderLoginState) => {
      if (!live) return
      // Another connection's sign-in is not this one's to show.
      if (state.active && state.provider === id) {
        setLogin({ active: true, url: state.url })
        return
      }
      setLogin({ active: false, url: null })
      if (state.result && state.result.provider === id) report(state.result)
    }
    const unsubscribe = api.onProviderLoginState(apply)
    api.provider.loginState().then(apply, () => {})
    return () => {
      live = false
      unsubscribe()
    }
  }, [api, id])
  useEffect(() => {
    let live = true
    api.provider.get().then(
      (next) => {
        if (live && next.provider === id) report(next)
      },
      () => {
        if (live) setError('Provider request failed. Try again.')
      },
    )
    return () => {
      live = false
    }
  }, [api, id])
  const run = async (operation: () => Promise<ProviderStatus>) => {
    setBusy(true)
    setError(null)
    try {
      // The app keeps the status even if the dialog was closed meanwhile.
      onStatus(await operation())
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
  const authKind = connection.capabilities.authKind
  return (
    <>
      {waiting ? (
        <p className="settings-status" role="status">
          {authKind === 'chatgpt-login'
            ? 'Waiting for you to finish signing in to ChatGPT in your browser…'
            : 'Waiting for sign-in…'}
        </p>
      ) : status?.state === 'error' && authKind !== 'local' ? (
        <p className="settings-error" role="alert">
          {plainText(status.message)}
        </p>
      ) : (
        <p role="status">
          {isConnected(status)
            ? 'Connected'
            : authKind === 'local'
              ? // A local server's own wording ("not running … check again") is the status.
                plainText(status?.message ?? 'Not checked yet')
              : status?.state === 'missing-runtime'
                ? `Can’t start ${connection.runtimeLabel ?? 'the runtime'}`
                : status?.state === 'signed-out'
                  ? // Sign in with ChatGPT says why it has to sign in again (ended, consent).
                    authKind === 'chatgpt-login' && status.failure
                    ? plainText(status.message)
                    : 'Not signed in'
                  : plainText(status?.message ?? 'Loading provider…')}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {(status?.state === 'error' || status?.state === 'missing-runtime' || error) &&
        authKind !== 'local' && (
          <button
            type="button"
            className="settings-retry"
            disabled={busy}
            onClick={() => {
              void run(() => api.provider.get())
            }}
          >
            Retry
          </button>
        )}
      {authKind === 'local' && !isConnected(status) && (
        <button
          type="button"
          className="button-primary"
          disabled={busy}
          onClick={() => {
            void run(() => api.provider.get())
          }}
        >
          Check again
        </button>
      )}
      {authKind === 'local' && connection.defaultBaseUrl && (
        <BaseUrlField
          connection={connection}
          onChanged={() => {
            void run(() => api.provider.get())
          }}
        />
      )}
      {authKind === 'chatgpt-login' && (
        <ChatgptSignIn
          busy={busy}
          active={login.active}
          onSignIn={() => {
            void signIn()
          }}
          onCancel={() => {
            void api.provider.cancelLogin()
          }}
        />
      )}
      {authKind === 'runtime-login' && (
        <>
          <button
            type="button"
            disabled={busy || login.active}
            onClick={() => {
              void signIn()
            }}
          >
            Sign in
          </button>
          {(busy || login.active) && (
            <button
              type="button"
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
    </>
  )
}

/**
 * Sign in with ChatGPT: main opens the browser and waits on its own loopback listener, so
 * there is no link or code to show here, only the button and Cancel while it waits. A
 * plain button for now: OpenAI's official button artwork replaces it (the
 * `data-sign-in="chatgpt"` hook), keeping the same accessible name.
 */
function ChatgptSignIn({
  busy,
  active,
  onSignIn,
  onCancel,
}: {
  busy: boolean
  active: boolean
  onSignIn: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <button
        type="button"
        className="button-primary"
        data-sign-in="chatgpt"
        disabled={busy || active}
        onClick={onSignIn}
      >
        Sign in with ChatGPT
      </button>
      {(busy || active) && (
        <button type="button" onClick={onCancel}>
          Cancel sign-in
        </button>
      )}
    </div>
  )
}
