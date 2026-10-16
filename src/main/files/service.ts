import type { FilesChanged } from '../../shared/ipc-files'
import type { FilesService } from '../ipc-files'
import type { PathGuard } from '../permissions/guard'
import { referenceFor, withEntryPath } from './actions'
import { listFolder, nodeListFs, type ListFs } from './listing'
import { filesRoots, resolveLocation, rootForId } from './location'
import { searchFiles } from './search'
import { FolderWatcher, type WatchFolder } from './watcher'

export interface FilesServiceDeps {
  guard: PathGuard
  /** Shows a path in Explorer: Electron's shell.showItemInFolder. */
  reveal: (path: string) => void
  copyText: (text: string) => Promise<void>
  emit: (change: FilesChanged) => void
  fs?: ListFs
  watch?: WatchFolder
}

/** The Workspace panel's file tree, as main provides it. */
export function createFilesService(deps: FilesServiceDeps): FilesService & { close(): void } {
  const { guard } = deps
  const fs = deps.fs ?? nodeListFs
  const watcher = new FolderWatcher({
    async resolve(location) {
      const where = await resolveLocation(guard, location)
      return where.ok && where.exists ? where.path : null
    },
    isGranted: (id) => rootForId(guard, id) !== null,
    emit: deps.emit,
    ...(deps.watch ? { watch: deps.watch } : {}),
  })
  return {
    roots: () => filesRoots(guard),
    list: (location) => listFolder(guard, location, fs),
    watch: (locations) => watcher.sync(locations),
    search: (query) => searchFiles(guard, query),
    reveal: (location) => withEntryPath(guard, location, deps.reveal, fs),
    copyPath: (location) => withEntryPath(guard, location, deps.copyText, fs),
    reference: (location) => referenceFor(guard, location, fs),
    close: () => {
      watcher.close()
    },
  }
}
