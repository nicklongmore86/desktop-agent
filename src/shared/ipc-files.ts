/**
 * The Workspace panel's file tree: channel names, types and limits shared by main,
 * preload and renderer. One of the per-feature IPC modules; see docs/ipc-modules.md.
 *
 * The renderer never sends an absolute path. It names a granted folder by the
 * opaque `id` main gives it (`files.roots()`) and a place inside it by a
 * `/`-separated relative path made of names main listed. Main re-resolves both
 * against the current grants through PathGuard on every call.
 */
import type { FilesAttachApi } from './ipc-attachments'

export const filesChannels = {
  filesRoots: 'files:roots',
  filesList: 'files:list',
  filesWatch: 'files:watch',
  filesSearch: 'files:search',
  filesReveal: 'files:reveal',
  filesCopyPath: 'files:copy-path',
  filesReference: 'files:reference',
} as const

/** Main -> renderer: an expanded folder changed on disk (or its watcher stopped). */
export const filesPushChannels = {
  filesChanged: 'files:changed',
} as const

/** Most entries one folder listing returns; the rest are counted in `more`. */
export const FILES_MAX_ENTRIES = 2000
/** Most folders watched at once (one non-recursive watcher each). */
export const FILES_MAX_WATCHED = 64
/** Longest relative path main accepts, in characters. */
export const FILES_MAX_REL = 4096
/** Most results the `@` mention search returns. */
export const FILES_SEARCH_LIMIT = 20
/** Longest `@` search query, in characters. */
export const FILES_MAX_QUERY = 200

/** A granted folder as the tree shows it. `path` is for display only; calls use `id`. */
export interface FilesRoot {
  id: string
  name: string
  path: string
}

/** A place in the tree: a granted folder's id and a `/`-separated path inside it ('' = the folder). */
export interface FileLocation {
  rootId: string
  rel: string
}

export type FileEntryKind = 'file' | 'dir' | 'link' | 'other'

/**
 * One entry of a folder listing.
 * - `denied`: on the agent's blocklist (keys, credentials, app data). Listed by name
 *   only, never opened, expanded, referenced or dragged.
 * - `secret`: a secrets file (`.env`, credentials, ...) the panels keep closed: its
 *   name shows with a lock, nothing in the panel opens or references it. This does
 *   not change what the agent itself may read.
 * - `link`: a symbolic link or junction. Never followed or expanded; `linkOutside`
 *   says whether its target is outside the granted folders.
 * - `hardLink`: a file with other hard links, which the agent's tools refuse.
 */
export interface FileEntry {
  name: string
  /** `/`-separated path from the granted folder. */
  rel: string
  kind: FileEntryKind
  /** Bytes, files only. */
  size?: number
  mtimeMs?: number
  denied?: string
  secret?: boolean
  linkOutside?: boolean
  hardLink?: boolean
}

export type FilesListResult =
  | {
      ok: true
      entries: FileEntry[]
      /** Entries past FILES_MAX_ENTRIES, not returned. */ more: number
    }
  | { ok: false; reason: string }

/** What `@` search returns: entries found inside the granted folders. */
export interface FileSearchHit extends FileLocation {
  name: string
  kind: 'file' | 'dir'
  /** The granted folder's name, to tell same-named files apart. */
  rootName: string
}

export type FileReferenceResult =
  | {
      ok: true
      /** Text to insert into the message, e.g. `@"C:\Users\me\notes.md"`. */ text: string
    }
  | {
      ok: false
      reason: string
    }

export type FileActionResult = { ok: true } | { ok: false; reason: string }

/**
 * Pushed when a watched folder changed (the renderer re-lists it) or when its
 * watcher had to stop (`stopped`: the folder is gone, its grant was removed, or
 * watching failed; the renderer offers a manual refresh).
 */
export interface FilesChanged extends FileLocation {
  stopped?: boolean
}

export interface FilesApi {
  files: FilesAttachApi & {
    /** The granted folders, with the ids every other call takes. */
    roots: () => Promise<FilesRoot[]>
    /** One level of a folder, listed through PathGuard. Links are listed, never followed. */
    list: (location: FileLocation) => Promise<FilesListResult>
    /**
     * Replaces the set of watched (expanded) folders. Main watches each one
     * non-recursively and stops watching anything not in the list.
     */
    watch: (locations: FileLocation[]) => Promise<void>
    /** Files and folders whose name contains `query`, for the `@` menu. */
    search: (query: string) => Promise<FileSearchHit[]>
    /** Shows the entry in Explorer (or the OS file manager). */
    reveal: (location: FileLocation) => Promise<FileActionResult>
    /** Copies the entry's full path to the clipboard (main does the copy). */
    copyPath: (location: FileLocation) => Promise<FileActionResult>
    /**
     * The reference text for an entry, resolved by main through PathGuard. It is
     * plain text in the message: it grants nothing, and the agent's tools check
     * the path again when they use it.
     */
    reference: (location: FileLocation) => Promise<FileReferenceResult>
    onChanged: (listener: (change: FilesChanged) => void) => () => void
  }
}
