import { useId, useState, type SubmitEvent } from 'react'
import { KEY_HELP } from '../../../../shared/access-matrix'
import type { ApiKeyStatus } from '../../../../shared/ipc'
import type { ConnectionId } from '../../../../shared/ipc-connections'
import { useApi } from '../../api'
import { useMounted } from './use-mounted'

/**
 * Saving an API key for a connection: a masked field, a link to where the key
 * comes from, and Save. Main stores and checks the key; the renderer only ever
 * learns whether one is saved, so a saved key is never shown again.
 */
export function ApiKeyForm({
  connection,
  label,
  saved,
  notice,
  onSaved,
}: {
  connection: ConnectionId
  /** The connection's name for the field label: "OpenAI API". */
  label: string
  saved: boolean
  /** A warning from the connection (a free key's data use), shown above the field. */
  notice?: string | undefined
  onSaved: (status: ApiKeyStatus) => void
}): React.JSX.Element {
  const api = useApi()
  const mounted = useMounted()
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const help = KEY_HELP[connection]

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const key = draft.trim()
    if (!key || busy) return
    setBusy(true)
    setError(null)
    api.apiKey.set(key, connection).then(
      (status) => {
        if (!mounted.current) return
        setBusy(false)
        if (status.error || !status.saved) {
          setError(status.error ?? 'That key was not accepted.')
          return
        }
        setDraft('')
        setJustSaved(true)
        onSaved(status)
      },
      () => {
        if (!mounted.current) return
        setBusy(false)
        setError('The request failed. Try again.')
      },
    )
  }

  return (
    <div className="key-form">
      {notice && (
        <p className="connection-notice" role="note">
          {notice}
        </p>
      )}
      <form className="settings-row" onSubmit={save}>
        <label htmlFor={inputId} className="visually-hidden">
          {label} key
        </label>
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={help?.placeholder ?? 'Paste your key'}
          value={draft}

          onChange={(event) => {
            setDraft(event.target.value)
          }}
        />
        <button type="submit" className="button-primary" disabled={busy || !draft.trim()}>
          {saved || justSaved ? 'Replace key' : 'Save key'}
        </button>
      </form>
      {help && (
        <p className="settings-hint">
          <a href={help.url} target="_blank" rel="noreferrer noopener">
            Get a key
          </a>
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {(saved || justSaved) && !error && (
        <p className="settings-status" role="status">
          Key saved and encrypted by Windows. It can’t be viewed again.
        </p>
      )}
    </div>
  )
}
