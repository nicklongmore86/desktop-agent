import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GrantsState } from '../../../../shared/ipc'
import type { FileEntry, FileLocation, FilesRoot } from '../../../../shared/ipc-files'
import { useApi } from '../../api'

/** One listed folder (a folder with none yet is loading). */
export type Listing =
  { status: 'ok'; entries: FileEntry[]; more: number } | { status: 'error'; reason: string }

/** A visible line of the tree, in display order. */
export type TreeRow =
  | { type: 'root'; key: string; root: FilesRoot; level: 1; expanded: boolean }
  | {
      type: 'entry'
      key: string
      rootId: string
      entry: FileEntry
      level: number
      expanded: boolean
      parentKey: string
    }
  | { type: 'status'; key: string; level: number; text: string; tone: 'muted' | 'error' }

export const locationKey = (location: FileLocation): string => `${location.rootId}\n${location.rel}`

export function keyLocation(key: string): FileLocation {
  const cut = key.indexOf('\n')
  return { rootId: key.slice(0, cut), rel: key.slice(cut + 1) }
}

/** Entries that open into a subtree. Links never do: they are not followed. */
export const isExpandable = (entry: FileEntry): boolean => entry.kind === 'dir' && !entry.denied

/**
 * The Files tree's data: the granted folders (as main names them), which folders
 * are expanded, their listings (fetched lazily, one level at a time), and the
 * watch list main keeps in step with the expanded folders. A folder main reports
 * as changed is re-listed; one whose watcher stopped keeps its listing and is
 * marked so the panel can offer a refresh.
 */
export function useFileTree(grants: GrantsState | null) {
  const api = useApi()
  const [roots, setRoots] = useState<FilesRoot[]>([])
  // Collapsed roots (roots start expanded) and expanded folders, by location key.
  const [collapsedRoots, setCollapsedRoots] = useState<ReadonlySet<string>>(new Set())
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set())
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(new Map())
  const [unwatched, setUnwatched] = useState<ReadonlySet<string>>(new Set())
  // The latest request per folder (older answers are dropped) and those still pending.
  const requested = useRef(new Map<string, number>())
  const pending = useRef(new Set<string>())
  const counter = useRef(0)

  useEffect(() => {
    let live = true
    const apply = (next: FilesRoot[]): void => {
      if (!live) return
      setRoots(next)
      // Forget the listings of folders that are no longer granted.
      const ids = new Set(next.map((root) => root.id))
      setListings((current) => {
        const kept = [...current].filter(([key]) => ids.has(keyLocation(key).rootId))
        return kept.length === current.size ? current : new Map(kept)
      })
    }
    api.files.roots().then(apply, () => {
      apply([])
    })
    return () => {
      live = false
    }
  }, [api, grants])

  const expanded = useMemo(() => {
    const ids = new Set(roots.map((root) => root.id))
    const keys = roots
      .map((root) => locationKey({ rootId: root.id, rel: '' }))
      .filter((key) => !collapsedRoots.has(key))
    // A folder shows only when its root and every parent are expanded too.
    const open = new Set(keys)
    const sorted = [...expandedDirs].sort((a, b) => a.length - b.length)
    for (const key of sorted) {
      const { rootId, rel } = keyLocation(key)
      if (!ids.has(rootId)) continue
      const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      if (open.has(locationKey({ rootId, rel: parentRel }))) open.add(key)
    }
    return open
  }, [roots, collapsedRoots, expandedDirs])

  /** Fetches a folder's listing. Until it arrives the folder shows its last listing, or "Loading…". */
  const load = useCallback(
    (key: string) => {
      const ticket = ++counter.current
      requested.current.set(key, ticket)
      pending.current.add(key)
      const settle = (listing: Listing): void => {
        if (requested.current.get(key) !== ticket) return
        pending.current.delete(key)
        setListings((current) => new Map(current).set(key, listing))
      }
      api.files.list(keyLocation(key)).then(
        (result) => {
          settle(
            result.ok
              ? { status: 'ok', entries: result.entries, more: result.more }
              : { status: 'error', reason: result.reason },
          )
        },
        () => {
          settle({ status: 'error', reason: 'Could not list the folder.' })
        },
      )
    },
    [api],
  )

  // List every expanded folder that has not been listed yet.
  useEffect(() => {
    for (const key of expanded) if (!listings.has(key) && !pending.current.has(key)) load(key)
  }, [expanded, listings, load])

  // Keep main watching exactly the expanded folders (it drops the rest).
  const watchList = useMemo(() => [...expanded].sort().join('\0'), [expanded])
  useEffect(() => {
    const locations = watchList === '' ? [] : watchList.split('\0').map(keyLocation)
    api.files.watch(locations).catch(() => {
      setUnwatched(new Set(locations.map(locationKey)))
    })
  }, [api, watchList])
  useEffect(
    () => () => {
      void api.files.watch([]).catch(() => {})
    },
    [api],
  )

  const expandedRef = useRef(expanded)
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])
  useEffect(
    () =>
      api.files.onChanged((change) => {
        const key = locationKey(change)
        if (!expandedRef.current.has(key)) return
        if (change.stopped) setUnwatched((current) => new Set(current).add(key))
        else load(key)
      }),
    [api, load],
  )

  const forgetUnwatched = (key: string): void => {
    setUnwatched((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  const setOpen = useCallback(
    (key: string, open: boolean) => {
      // Re-list on every expand: a collapsed folder was not watched, so it may be stale.
      // Main starts watching it again, so it is no longer marked as unwatched.
      if (open) load(key)
      forgetUnwatched(key)
      const { rel } = keyLocation(key)
      if (rel === '') {
        setCollapsedRoots((current) => {
          const next = new Set(current)
          if (open) next.delete(key)
          else next.add(key)
          return next
        })
        return
      }
      setExpandedDirs((current) => {
        const next = new Set(current)
        if (open) next.add(key)
        else next.delete(key)
        return next
      })
    },
    [load],
  )

  /** Re-lists a folder now (the manual refresh when its watcher stopped). */
  const refresh = useCallback(
    (key: string) => {
      forgetUnwatched(key)
      load(key)
    },
    [load],
  )

  const rows = useMemo(() => {
    const out: TreeRow[] = []
    const addChildren = (rootId: string, key: string, level: number): void => {
      const listing = listings.get(key)
      if (!listing) {
        out.push({
          type: 'status',
          key: `${key}\n:loading`,
          level,
          text: 'Loading…',
          tone: 'muted',
        })
        return
      }
      if (listing.status === 'error') {
        out.push({
          type: 'status',
          key: `${key}\n:error`,
          level,
          text: listing.reason,
          tone: 'error',
        })
        return
      }
      if (listing.entries.length === 0)
        out.push({
          type: 'status',
          key: `${key}\n:empty`,
          level,
          text: 'Empty folder',
          tone: 'muted',
        })
      for (const entry of listing.entries) {
        const childKey = locationKey({ rootId, rel: entry.rel })
        const open = isExpandable(entry) && expanded.has(childKey)
        out.push({
          type: 'entry',
          key: childKey,
          rootId,
          entry,
          level,
          expanded: open,
          parentKey: key,
        })
        if (open) addChildren(rootId, childKey, level + 1)
      }
      if (listing.more > 0)
        out.push({
          type: 'status',
          key: `${key}\n:more`,
          level,
          text: `${listing.more.toLocaleString()} more not shown`,
          tone: 'muted',
        })
    }
    for (const root of roots) {
      const key = locationKey({ rootId: root.id, rel: '' })
      const open = expanded.has(key)
      out.push({ type: 'root', key, root, level: 1, expanded: open })
      if (open) addChildren(root.id, key, 2)
    }
    return out
  }, [roots, listings, expanded])

  return { roots, rows, setOpen, refresh, unwatched }
}
