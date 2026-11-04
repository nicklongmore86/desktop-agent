import type { FilesChanged } from '../../shared/ipc-files'
import type { FilesService } from '../ipc-files'
import type { AuditSink } from '../permissions/audit'
import type { PathGuard } from '../permissions/guard'
import { referenceFor, withEntryPath } from './actions'
import { openMention, resolveMentions } from './mention'
import { listFolder, nodeListFs, type ListFs } from './listing'
import { filesRoots, resolveLocation, rootForId } from './location'
import { searchFiles } from './search'
import { FolderWatcher, type WatchFolder } from './watcher'

export interface FilesServiceDeps {
  guard: PathGuard
  /** Shows a path in Explorer: Electron's shell.showItemInFolder. */
  reveal: (path: string) => void
  /** Opens a file or folder with its default app: Electron's shell.openPath ('' or an error message). */
  open?: (path: string) => Promise<string>
  /** Where opens and reveals from a reply are recorded. */
  audit?: AuditSink
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
    // Reveal hands the file to Explorer, so it is refused for secret files; copying
    // the path opens nothing and stays allowed (see withEntryPath).
    reveal: (location) => withEntryPath(guard, location, deps.reveal, 'refuse', fs),
    copyPath: (location) => withEntryPath(guard, location, deps.copyText, 'allow', fs),
    reference: (location) => referenceFor(guard, location, fs),
    // Files and folders named in a reply: main decides (files/mention.ts).
    resolveMentions: (texts) => resolveMentions(guard, texts, fs),
    openMention: (text) =>
      openMention(
        guard,
        text,
        {
          open: deps.open ?? (() => Promise.resolve('Opening files is unavailable.')),
          reveal: deps.reveal,
          audit: deps.audit ?? { record: () => Promise.resolve() },
        },
        fs,
      ),
    close: () => {
      watcher.close()
    },
  }
}
