import { filesChannels, filesPushChannels, type FilesApi } from '../shared/ipc-files'
import type { Invoke, Subscribe } from './features'

export const filesApi = (invoke: Invoke, subscribe: Subscribe): FilesApi => ({
  files: {
    roots: () => invoke(filesChannels.filesRoots),
    list: (location) => invoke(filesChannels.filesList, location),
    watch: (locations) => invoke(filesChannels.filesWatch, locations),
    search: (query) => invoke(filesChannels.filesSearch, query),
    reveal: (location) => invoke(filesChannels.filesReveal, location),
    copyPath: (location) => invoke(filesChannels.filesCopyPath, location),
    reference: (location) => invoke(filesChannels.filesReference, location),
    onChanged: (listener) => subscribe(filesPushChannels.filesChanged, listener),
  },
})
