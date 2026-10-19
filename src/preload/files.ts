import { webUtils } from 'electron'
import { attachmentsChannels } from '../shared/ipc-attachments'
import { filesChannels, filesPushChannels, type FilesApi } from '../shared/ipc-files'
import type { Invoke, Subscribe } from './features'

/** A File's path on disk, read here so the renderer never handles it ('' when it has none). */
type PathForFile = (file: File) => string

export const filesApi = (
  invoke: Invoke,
  subscribe: Subscribe,
  pathForFile: PathForFile = (file) => webUtils.getPathForFile(file),
): FilesApi => ({
  files: {
    roots: () => invoke(filesChannels.filesRoots),
    list: (location) => invoke(filesChannels.filesList, location),
    watch: (locations) => invoke(filesChannels.filesWatch, locations),
    search: (query) => invoke(filesChannels.filesSearch, query),
    reveal: (location) => invoke(filesChannels.filesReveal, location),
    copyPath: (location) => invoke(filesChannels.filesCopyPath, location),
    reference: (location) => invoke(filesChannels.filesReference, location),
    onChanged: (listener) => subscribe(filesPushChannels.filesChanged, listener),
    // Only the path string crosses IPC. A drag with no file behind it (an item inside a
    // zip folder, a browser image) has an empty path and is refused without calling main.
    attachDropped: (file) => {
      let path = ''
      try {
        path = pathForFile(file)
      } catch {
        // Not a File from this page.
      }
      return path
        ? invoke(attachmentsChannels.attachmentsAttachDropped, path)
        : Promise.resolve({
            ok: false,
            code: 'invalid',
            reason:
              'This item is not a file on disk (for example, a file inside a zip folder). Extract it first.',
          })
    },
  },
})
