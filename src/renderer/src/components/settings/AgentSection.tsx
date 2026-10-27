import { useEffect, useId, useState, type SubmitEvent } from 'react'
import { TURN_LIMIT } from '../../../../shared/ipc'
import { useApi } from '../../api'

/** How many steps a reply may take before it pauses (main validates and saves it). */
export function AgentSection(): React.JSX.Element {
  const api = useApi()
  const inputId = useId()
  const hintId = useId()
  const [saved, setSaved] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.turnLimit.get().then(
      (limit) => {
        if (!live) return
        setSaved(limit)
        setDraft(String(limit))
      },
      () => {
        if (live) setError('The current limit could not be read.')
      },
    )
    return () => {
      live = false
    }
  }, [api])
  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const limit = Number(draft.trim())
    if (!Number.isInteger(limit) || limit < TURN_LIMIT.min || limit > TURN_LIMIT.max) {
      setStatus(null)
      setError(
        `Choose a whole number of steps from ${String(TURN_LIMIT.min)} to ${String(TURN_LIMIT.max)}.`,
      )
      return
    }
    setBusy(true)
    setError(null)
    api.turnLimit.set(limit).then(
      (stored) => {
        setBusy(false)
        setSaved(stored)
        setDraft(String(stored))
        setStatus('Saved. It applies from your next message.')
      },
      () => {
        setBusy(false)
        setStatus(null)
        setError('The limit could not be saved. Try again.')
      },
    )
  }
  return (
    <section className="settings-section">
      <h3>Agent</h3>
      {/* Our own message, not the browser's range tooltip. */}
      <form className="settings-row" noValidate onSubmit={save}>
        <label htmlFor={inputId}>Steps per message</label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={TURN_LIMIT.min}
          max={TURN_LIMIT.max}
          step={1}
          value={draft}
          disabled={saved === null}
          aria-describedby={hintId}
          onChange={(event) => {
            setDraft(event.target.value)
            setStatus(null)
            setError(null)
          }}
        />
        <button type="submit" disabled={busy || saved === null}>
          Save
        </button>
      </form>
      <p id={hintId} className="settings-hint">
        How many steps (model replies and tool calls) one message may take before the agent pauses
        and asks to continue. Your progress is kept when it pauses. From {TURN_LIMIT.min} to{' '}
        {TURN_LIMIT.max}; the default is {TURN_LIMIT.default}. Applies to Claude API, ChatGPT plan,
        Gemini and OpenAI-compatible connections. Claude and Codex subscriptions use their own
        limits.
      </p>
      {status && (
        <p className="settings-hint" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
