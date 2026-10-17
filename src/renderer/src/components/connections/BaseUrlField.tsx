import { useEffect, useId, useState, type SubmitEvent } from 'react'
import type { ConnectionBaseUrl, ConnectionInfo } from '../../../../shared/ipc-connections'
import { plainText } from '../../plain-text'
import { useApi } from '../../api'
import { useMounted } from './use-mounted'

/**
 * Advanced: where a local server listens, when it is not on its usual address.
 * Main accepts an address on this PC only and says why when it refuses one; the
 * renderer shows that reason as plain text and keeps nothing it was refused.
 */
export function BaseUrlField({
  connection,
  onChanged,
}: {
  connection: ConnectionInfo
  /** The address was saved or reset: look for the server again. */
  onChanged: () => void
}): React.JSX.Element {
  const api = useApi()
  const mounted = useMounted()
  const inputId = useId()
  const hintId = useId()
  const [saved, setSaved] = useState<ConnectionBaseUrl | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.connections.baseUrl(connection.id).then(
      (value) => {
        if (!live) return
        setSaved(value)
        setDraft(value.custom ? value.baseUrl : '')
      },
      () => {
        // No field to show without an address to start from.
      },
    )
    return () => {
      live = false
    }
  }, [api, connection.id])

  const apply = (next: string | null): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    api.connections.setBaseUrl(connection.id, next).then(
      (value) => {
        if (!mounted.current) return
        setBusy(false)
        if (value.error) {
          setError(plainText(value.error))
          return
        }
        setSaved(value)
        setDraft(value.custom ? value.baseUrl : '')
        onChanged()
      },
      () => {
        if (!mounted.current) return
        setBusy(false)
        setError('The request failed. Try again.')
      },
    )
  }
  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const value = draft.trim()
    apply(value === '' ? null : value)
  }
  const fallback = connection.defaultBaseUrl ?? ''
  return (
    <details className="advanced-field">
      <summary>Advanced</summary>
      <form className="settings-row" onSubmit={save}>
        <label htmlFor={inputId}>Server address</label>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={fallback}
          value={draft}
          aria-describedby={hintId}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
        />
        <button type="submit" disabled={busy}>
          Save address
        </button>
        {saved?.custom && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              apply(null)
            }}
          >
            Use the usual address
          </button>
        )}
      </form>
      <p id={hintId} className="settings-hint">
        Only an address on this PC works, like {fallback}. Leave it empty for the usual one.
      </p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </details>
  )
}
