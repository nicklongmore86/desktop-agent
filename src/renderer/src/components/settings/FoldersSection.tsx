import type { SettingsPanelProps } from '../SettingsPanel'
import { useGrantActions } from './use-grant-actions'

export function FoldersSection({
  grants,
  onGrants,
}: Pick<SettingsPanelProps, 'grants' | 'onGrants'>): React.JSX.Element {
  const { message, busy, add, remove } = useGrantActions(onGrants)
  const roots = grants?.roots ?? []

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
