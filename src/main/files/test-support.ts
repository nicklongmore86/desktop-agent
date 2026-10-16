// Helpers for the files tests. Not imported by app code.
import path from 'node:path'
import type { GuardFs } from '../permissions/guard'
import { fakeWindowsFs } from '../permissions/test-support'
import type { ListFs, ListStats } from './listing'

export interface FakeTree {
  /** Folders that exist (real, long-name paths). */
  dirs: readonly string[]
  /** Files that exist, with their link count (default 1). */
  files?: Record<string, { size?: number; nlink?: number }>
  /** A link's path -> its target (folder links are junctions on Windows). */
  links?: Record<string, string>
  /** An 8.3 alias path -> the long path it names. */
  shortNames?: Record<string, string>
}

function enoent(p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
}

/**
 * An in-memory Windows tree: the guard's fake file system (permissions/test-support's
 * fakeWindowsFs: case-insensitive, junctions, 8.3 aliases) plus the listing calls.
 * `lstats` records every path the listing stat'ed, so tests can prove that a
 * blocklisted entry was never touched.
 */
export function fakeWindowsTree(tree: FakeTree): {
  guardFs: GuardFs
  listFs: ListFs
  lstats: string[]
} {
  const files = tree.files ?? {}
  const links = tree.links ?? {}
  const guardFs = fakeWindowsFs([...tree.dirs, ...Object.keys(files)], links, tree.shortNames)
  const lower = (p: string) => path.win32.normalize(p).toLowerCase()
  const dirs = new Set(tree.dirs.map(lower))
  const fileMap = new Map(Object.entries(files).map(([p, info]) => [lower(p), info]))
  const linkSet = new Set(Object.keys(links).map(lower))
  const lstats: string[] = []
  const stats = (kind: 'dir' | 'file' | 'link', info: { size?: number; nlink?: number } = {}) =>
    ({
      isSymbolicLink: () => kind === 'link',
      isDirectory: () => kind === 'dir',
      isFile: () => kind === 'file',
      size: info.size ?? 0,
      mtimeMs: 1_700_000_000_000,
      nlink: info.nlink ?? 1,
    }) satisfies ListStats
  const listFs: ListFs = {
    readdir: (p) => guardFs.readdir(p),
    lstat: (p) => {
      lstats.push(p)
      const key = lower(p)
      if (linkSet.has(key)) return Promise.resolve(stats('link'))
      if (dirs.has(key)) return Promise.resolve(stats('dir'))
      const file = fileMap.get(key)
      if (file) return Promise.resolve(stats('file', file))
      return Promise.reject(enoent(p))
    },
  }
  return { guardFs, listFs, lstats }
}
