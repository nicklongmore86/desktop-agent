import { useState } from 'react'
import { useApi } from '../../api'
import type { SettingsPanelProps } from '../SettingsPanel'
export function FoldersSection({
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
      <h3 id="grants-title">Folders &amp; permissions</h3>
      <p className="settings-hint">Desktop Agent can only access these folders.</p>
      <p className="settings-hint">You approve every change and shell command.</p>
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
        <p className="settings-status">
          No folders yet. Add one so the agent can work with your files.
        </p>
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
