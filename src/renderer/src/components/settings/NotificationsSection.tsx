import { useEffect, useId, useState } from 'react'
import { useApi } from '../../api'

/** The notifications toggle: main shows them (and flashes the taskbar); this only saves the choice. */
export function NotificationsSection(): React.JSX.Element {
  const api = useApi()
  const inputId = useId()
  const hintId = useId()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.notifications.get().then(
      (value) => {
        if (live) setEnabled(value)
      },
      () => {
        if (live) setError('The current setting could not be read.')
      },
    )
    return () => {
      live = false
    }
  }, [api])
  const change = (next: boolean): void => {
    setBusy(true)
    setError(null)
    api.notifications.set(next).then(
      (saved) => {
        setBusy(false)
        setEnabled(saved)
      },
      () => {
        setBusy(false)
        setError('The setting could not be saved. Try again.')
      },
    )
  }
  return (
    <section className="settings-section">
      <h3>Notifications</h3>
      <label htmlFor={inputId} className="settings-toggle">
        <input
          id={inputId}
          type="checkbox"
          checked={enabled ?? true}
          disabled={enabled === null || busy}
          aria-describedby={hintId}
          onChange={(event) => {
            change(event.target.checked)
          }}
        />
        Notify me when Desktop Agent needs me
      </label>
      <p id={hintId} className="settings-hint">
        When the window is not in front, show a notification and flash its taskbar button as a reply
        finishes or fails, or an approval is waiting. The notification only says that; it never
        shows your messages, replies, file names or commands, and clicking it only brings the window
        back. Approvals are always answered in the window.
      </p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
