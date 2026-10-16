import type { GrantsState } from '../../../../../shared/ipc'
import type { OpenSettings } from '../../../open-settings'
import { FileTree } from '../../files/FileTree'
import { useFileTree } from '../../files/use-file-tree'
import { useGrantActions } from '../../settings/use-grant-actions'

/**
 * The Workspace panel's Files tab: the granted folders as a file tree, plus adding
 * and removing folders (shared with Settings, with the same refusal reasons).
 * Everything the tree shows comes from main's guarded listing.
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
  const tree = useFileTree(grants)
  const granted = (grants?.roots.length ?? 0) > 0
  return (
    <section className="files-tab" aria-labelledby="folder-access-title">
      <div className="files-header">
        <h2 id="folder-access-title" className="sidebar-label">
          Folder access
        </h2>
        <div className="files-header-actions">
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
      </div>
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
      {granted ? (
        <FileTree
          rows={tree.rows}
          setOpen={tree.setOpen}
          refresh={tree.refresh}
          unwatched={tree.unwatched}
          onRemoveRoot={(root) => {
            void remove(root)
          }}
        />
      ) : (
        <div className="files-empty">
          <p className="sidebar-hint">No folders granted</p>
          <p className="sidebar-hint">
            Add a folder to browse its files here and let the agent work with them.
          </p>
        </div>
      )}
    </section>
  )
}
