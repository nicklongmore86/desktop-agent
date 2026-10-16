// Watches the folders expanded in the tree: one non-recursive watcher per
// folder (recursive watches on a big tree like Downloads or node_modules hold
// too many handles), coalesced, and dropped as soon as the folder is collapsed
// or its grant is gone.
import { watch as nodeWatch } from 'node:fs'
import { FILES_MAX_WATCHED, type FileLocation, type FilesChanged } from '../../shared/ipc-files'

export interface WatchHandle {
  close(): void
}

/** Starts watching one folder (not its subfolders). */
export type WatchFolder = (
  path: string,
  onChange: () => void,
  onError: (error: unknown) => void,
) => WatchHandle

export const nodeWatchFolder: WatchFolder = (path, onChange, onError) => {
  const watcher = nodeWatch(path, { persistent: false, recursive: false }, () => {
    onChange()
  })
  watcher.on('error', onError)
  return watcher
}

export interface FolderWatcherOptions {
  /** Resolves a location to a real folder path through PathGuard, or null when refused. */
  resolve: (location: FileLocation) => Promise<string | null>
  /** True while the granted folder an id names is still granted. */
  isGranted: (rootId: string) => boolean
  emit: (change: FilesChanged) => void
  watch?: WatchFolder
  /** Changes inside this window are reported once. */
  debounceMs?: number
  /** How often open watchers re-check that their grant still exists. */
  pruneMs?: number
  max?: number
}

interface Watched {
  location: FileLocation
  handle: WatchHandle | null
  timer: ReturnType<typeof setTimeout> | null
}

const keyOf = (location: FileLocation): string => `${location.rootId}\n${location.rel}`

export class FolderWatcher {
  private readonly watched = new Map<string, Watched>()
  /** The locations last asked for; a slow resolve that finishes after a newer sync is dropped. */
  private wanted = new Set<string>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private readonly watchFolder: WatchFolder
  private readonly debounceMs: number
  private readonly pruneMs: number
  private readonly max: number

  constructor(private readonly options: FolderWatcherOptions) {
    this.watchFolder = options.watch ?? nodeWatchFolder
    this.debounceMs = options.debounceMs ?? 250
    this.pruneMs = options.pruneMs ?? 1000
    this.max = options.max ?? FILES_MAX_WATCHED
  }

  /** The locations being watched right now. */
  active(): FileLocation[] {
    return [...this.watched.values()].filter((w) => w.handle).map((w) => w.location)
  }

  /** Watches exactly `locations` (the first `max` of them): starts new ones, stops the rest. */
  async sync(locations: readonly FileLocation[]): Promise<void> {
    const next = new Map<string, FileLocation>()
    for (const location of locations) {
      if (next.size >= this.max) break
      next.set(keyOf(location), { rootId: location.rootId, rel: location.rel })
    }
    this.wanted = new Set(next.keys())
    for (const key of [...this.watched.keys()]) if (!next.has(key)) this.stop(key)
    this.prune()
    await Promise.all(
      [...next].map(async ([key, location]) => {
        if (this.watched.has(key) || !this.options.isGranted(location.rootId)) return
        // Reserve the slot so a second sync does not start a second watcher.
        const entry: Watched = { location, handle: null, timer: null }
        this.watched.set(key, entry)
        const path = await this.options.resolve(location)
        if (this.watched.get(key) !== entry) return
        if (!path || !this.wanted.has(key)) {
          this.watched.delete(key)
          if (!path) this.options.emit({ ...location, stopped: true })
          return
        }
        try {
          entry.handle = this.watchFolder(
            path,
            () => {
              this.changed(key)
            },
            () => {
              this.fail(key)
            },
          )
        } catch {
          this.watched.delete(key)
          this.options.emit({ ...location, stopped: true })
          return
        }
        this.startPruning()
      }),
    )
  }

  /** Stops every watcher whose grant has been removed, telling the renderer. */
  prune(): void {
    for (const [key, entry] of this.watched) {
      if (!this.options.isGranted(entry.location.rootId)) this.fail(key)
    }
  }

  close(): void {
    for (const key of [...this.watched.keys()]) this.stop(key)
    this.wanted.clear()
  }

  private changed(key: string): void {
    const entry = this.watched.get(key)
    if (!entry) return
    if (!this.options.isGranted(entry.location.rootId)) {
      this.fail(key)
      return
    }
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (this.watched.get(key) === entry) this.options.emit({ ...entry.location })
    }, this.debounceMs)
  }

  private fail(key: string): void {
    const entry = this.watched.get(key)
    if (!entry) return
    this.stop(key)
    this.options.emit({ ...entry.location, stopped: true })
  }

  private stop(key: string): void {
    const entry = this.watched.get(key)
    if (!entry) return
    this.watched.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    try {
      entry.handle?.close()
    } catch {
      // Already closed (the folder was deleted).
    }
    if (this.watched.size === 0 && this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
  }

  private startPruning(): void {
    if (this.pruneTimer) return
    this.pruneTimer = setInterval(() => {
      this.prune()
    }, this.pruneMs)
    // Never keeps the app alive on its own.
    ;(this.pruneTimer as { unref?: () => void }).unref?.()
  }
}
