import type { GrantsState } from '../../../../../shared/ipc'
import type { OpenSettings } from '../../../open-settings'
import { useGrantActions } from '../../settings/use-grant-actions'

/**
 * The Workspace panel's Files tab. For now it holds the folder-access list that used
 * to sit in the left sidebar, fully working (add, remove, refusal reasons). The file
 * tree replaces this component; keep the props or extend them.
 */
export function FilesTab({
  grants,
  onGrants,
  onOpenSettings,
}: {
  grants: GrantsState | null
  onGrants: (grants: GrantsState) => void
  onOpenSettings: OpenSettings
}): React.JSX.Element {
  const { message, busy, add, remove } = useGrantActions(onGrants)
  const roots = grants?.roots ?? []
  return (
    <section className="files-tab sidebar-folders" aria-labelledby="folder-access-title">
      <h2 id="folder-access-title" className="sidebar-label">
        Folder access
      </h2>
      {grants?.loadError && (
        <p className="sidebar-error" role="alert">
          {grants.loadError}
        </p>
      )}
      {message && (
        <p className="sidebar-error" role="alert">
          {message}
        </p>
      )}
      {roots.length ? (
        <ul aria-label="Granted folders">
          {roots.map((root) => (
            <li key={root}>
              <span aria-hidden="true">▱</span>
              <span className="folder-path">{root}</span>
              <button
                type="button"
                className="folder-remove"
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
      ) : (
        <p className="sidebar-hint">No folders granted</p>
      )}
      <div className="folder-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void add()
          }}
        >
          Add folder…
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenSettings('folders')
          }}
        >
          Manage folders
        </button>
      </div>
    </section>
  )
}
