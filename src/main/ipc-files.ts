import { z } from 'zod'
import {
  FILES_MAX_QUERY,
  FILES_MAX_REL,
  FILES_MAX_WATCHED,
  filesChannels,
  type FileActionResult,
  type FileLocation,
  type FileReferenceResult,
  type FileSearchHit,
  type FilesListResult,
  type FilesRoot,
} from '../shared/ipc-files'
import { ROOT_ID } from './files/location'
import type { IpcHandle } from './ipc-features'

export interface FilesService {
  roots: () => FilesRoot[]
  list: (location: FileLocation) => Promise<FilesListResult>
  watch: (locations: FileLocation[]) => Promise<void>
  search: (query: string) => Promise<FileSearchHit[]>
  reveal: (location: FileLocation) => Promise<FileActionResult>
  copyPath: (location: FileLocation) => Promise<FileActionResult>
  reference: (location: FileLocation) => Promise<FileReferenceResult>
}

// A location is a granted folder's opaque id and a relative path: never an absolute
// path. The service still resolves both through PathGuard (see files/location.ts).
const locationSchema = z.strictObject({
  rootId: z.string().regex(ROOT_ID),
  rel: z.string().max(FILES_MAX_REL),
})
const watchSchema = z.array(locationSchema).max(FILES_MAX_WATCHED * 4)
const querySchema = z.string().max(FILES_MAX_QUERY)

function location(value: unknown): FileLocation {
  const parsed = locationSchema.safeParse(value)
  if (!parsed.success) throw new Error('Unknown file.')
  return parsed.data
}

export function registerFilesHandlers(handle: IpcHandle, files: FilesService): void {
  handle(filesChannels.filesRoots, () => files.roots())
  handle(filesChannels.filesList, (value) => files.list(location(value)))
  handle(filesChannels.filesWatch, (value) => {
    const parsed = watchSchema.safeParse(value)
    if (!parsed.success) throw new Error('Invalid folders to watch.')
    return files.watch(parsed.data)
  })
  handle(filesChannels.filesSearch, (query) => {
    const parsed = querySchema.safeParse(query)
    if (!parsed.success) throw new Error('Invalid search.')
    return files.search(parsed.data)
  })
  handle(filesChannels.filesReveal, (value) => files.reveal(location(value)))
  handle(filesChannels.filesCopyPath, (value) => files.copyPath(location(value)))
  handle(filesChannels.filesReference, (value) => files.reference(location(value)))
}
