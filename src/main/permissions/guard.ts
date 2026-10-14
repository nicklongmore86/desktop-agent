import { promises as nodeFs } from 'node:fs'
import { blocklistReason } from './blocklist'
import { checkPathSyntax, foldCase, isInside, pathApi, samePath, type PathApi } from './paths'

/** The file-system calls the guard needs; injectable so tests can fake Windows on Linux. */
export interface GuardFs {
  /**
   * Like fs.promises.realpath: resolves symlinks and junctions and returns
   * long names (never 8.3 short names); rejects with `code` set.
   */
  realpath(p: string): Promise<string>
  /** Like fs.promises.lstat: describes the entry itself, without following a link. */
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>
  /** Like fs.promises.readdir: the long names of a folder's entries. */
  readdir(p: string): Promise<string[]>
}

const nodeGuardFs: GuardFs = {
  realpath: (p) => nodeFs.realpath(p),
  lstat: (p) => nodeFs.lstat(p),
  readdir: (p) => nodeFs.readdir(p),
}

export interface PathGuardOptions {
  /** Current granted roots (as stored: absolute real paths). Read on every check. */
  roots: () => readonly string[]
  /**
   * Locations that are always blocked, on top of the built-in blocklist: the
   * app's own userData (grants, audit log, key store).
   */
  protectedPaths?: readonly string[]
  platform?: NodeJS.Platform
  fs?: GuardFs
}

export interface ResolveOptions {
  /**
   * Resolve a symlink in the final segment to its target (default). Pass false
   * for operations on the entry itself (move, delete), where the link's
   * parent is resolved and the link is acted on, not its target.
   */
  followFinalSymlink?: boolean
}

export type Resolution =
  { ok: true; path: string; root: string; exists: boolean } | { ok: false; reason: string }

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

/**
 * Decides whether a tool may touch a path. A path is allowed only when its
 * real location (symlinks and junctions resolved; for paths that do not exist
 * yet, the real location of the nearest existing parent) is inside a granted
 * root and is not on the blocklist. Tools must act on the returned `path`,
 * never on the caller's input.
 */
export class PathGuard {
  readonly platform: NodeJS.Platform
  readonly path: PathApi
  private readonly roots: () => readonly string[]
  private readonly protectedPaths: readonly string[]
  private realProtectedPaths: readonly string[] = []
  private readonly fs: GuardFs

  constructor(options: PathGuardOptions) {
    this.platform = options.platform ?? process.platform
    this.path = pathApi(this.platform)
    this.roots = options.roots
    this.protectedPaths = (options.protectedPaths ?? []).map((p) => this.path.resolve(p))
    this.fs = options.fs ?? nodeGuardFs
  }

  async resolve(input: string, options: ResolveOptions = {}): Promise<Resolution> {
    const P = this.path
    const syntax = checkPathSyntax(input, this.platform)
    if (syntax) return { ok: false, reason: syntax }

    const normalized = P.resolve(input)
    await this.refreshProtectedPaths()
    const lexicalBlock = this.blockedReason(normalized)
    if (lexicalBlock) return { ok: false, reason: lexicalBlock }

    // Walk up to the nearest existing ancestor and resolve that for real.
    const tail: string[] = []
    let existing = normalized
    if (options.followFinalSymlink === false && P.dirname(normalized) !== normalized) {
      tail.push(P.basename(normalized))
      existing = P.dirname(normalized)
    }
    let real: string
    for (;;) {
      try {
        real = await this.fs.realpath(existing)
        break
      } catch (error) {
        const code = errorCode(error)
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          return { ok: false, reason: `Cannot access ${existing} (${code ?? 'unknown error'}).` }
        }
        if (await this.entryExists(existing)) {
          // realpath failed but the entry is there: a link whose target is missing.
          // Writing through it would create the target wherever it points.
          return {
            ok: false,
            reason: `${existing} is a symbolic link or junction whose target does not exist.`,
          }
        }
        const parent = P.dirname(existing)
        if (parent === existing) return { ok: false, reason: `No part of ${input} exists.` }
        tail.unshift(P.basename(existing))
        existing = parent
      }
    }
    let resolved = tail.length > 0 ? P.join(real, ...tail) : real
    let exists = tail.length === 0

    if (options.followFinalSymlink === false && tail.length === 1) {
      // The final entry is not followed, so realpath has not seen it. On
      // Windows its name may be an 8.3 alias (ENV~1.PRO for .env.production)
      // that slips past the blocklist: replace it with the entry's long name.
      const canonical = await this.canonicalFinalEntry(resolved)
      if (!canonical.ok) return canonical
      resolved = canonical.path
      exists = canonical.exists
    }

    // realpath can turn a mapped network drive into a UNC path.
    const realSyntax = checkPathSyntax(resolved, this.platform)
    if (realSyntax) return { ok: false, reason: realSyntax }

    const root = await this.rootFor(resolved)
    if (!root) return { ok: false, reason: this.outsideMessage(input) }

    const blocked = this.blockedReason(resolved)
    if (blocked) return { ok: false, reason: blocked }

    return { ok: true, path: resolved, root, exists }
  }

  /**
   * The long-name path of a final entry that must not be followed. A plain
   * file or folder is realpath'd (which expands short names); a link is
   * matched by name against its parent's listing, and refused when the
   * given name is not one of the listed (long) names, i.e. it is an alias.
   */
  private async canonicalFinalEntry(
    entry: string,
  ): Promise<{ ok: true; path: string; exists: boolean } | { ok: false; reason: string }> {
    const P = this.path
    let stats: { isSymbolicLink(): boolean }
    try {
      stats = await this.fs.lstat(entry)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, path: entry, exists: false }
      return { ok: false, reason: `Cannot access ${entry} (${code ?? 'unknown error'}).` }
    }
    const parent = P.dirname(entry)
    try {
      if (!stats.isSymbolicLink()) {
        const real = await this.fs.realpath(entry)
        if (!samePath(P.dirname(real), parent, this.platform)) {
          return { ok: false, reason: `${entry} changed while it was being checked.` }
        }
        return { ok: true, path: real, exists: true }
      }
      const name = foldCase(P.basename(entry), this.platform)
      const match = (await this.fs.readdir(parent)).find((n) => foldCase(n, this.platform) === name)
      if (match === undefined) {
        return {
          ok: false,
          reason: `${entry} is a short (8.3) or alias name for a link; use its full name.`,
        }
      }
      return { ok: true, path: P.join(parent, match), exists: true }
    } catch (error) {
      return {
        ok: false,
        reason: `Cannot access ${entry} (${errorCode(error) ?? 'unknown error'}).`,
      }
    }
  }

  /**
   * Why `p` is blocked (built-in blocklist or a protected app path), or null.
   * Synchronous so directory walks can filter entries cheaply; `p` must already
   * be a real path (walks do not follow links, so their children are).
   */
  blockedReason(p: string): string | null {
    const builtIn = blocklistReason(p, this.platform)
    if (builtIn) return builtIn
    for (const protectedPath of [...this.protectedPaths, ...this.realProtectedPaths]) {
      if (isInside(p, protectedPath, this.platform)) {
        return `${p} is part of the app's own data and is blocked.`
      }
    }
    return null
  }

  /** True when `resolved` is exactly one of the granted roots. */
  isRoot(resolved: string): boolean {
    return this.roots().some((root) => samePath(root, resolved, this.platform))
  }

  /**
   * Cheap synchronous check that `resolved` (already a real path) is still
   * inside one of the currently granted roots. Walks call it for every entry
   * so a grant revoked mid-walk stops the walk; the full check is resolve().
   */
  isWithinGrants(resolved: string): boolean {
    return this.roots().some((root) => isInside(resolved, root, this.platform))
  }

  /** True when `resolved` is a granted root or has one inside it (nested grants). */
  containsRoot(resolved: string): boolean {
    return this.roots().some((root) => isInside(root, resolved, this.platform))
  }

  private async rootFor(resolved: string): Promise<string | null> {
    let best: string | null = null
    for (const root of this.roots()) {
      // Re-check the root itself: if it has since been replaced by a link to
      // somewhere else, it no longer means what the user granted.
      let realRoot: string
      try {
        realRoot = await this.fs.realpath(root)
      } catch {
        continue
      }
      if (!samePath(realRoot, root, this.platform)) continue
      if (isInside(resolved, realRoot, this.platform) && (!best || realRoot.length > best.length)) {
        best = realRoot
      }
    }
    return best
  }

  private async refreshProtectedPaths(): Promise<void> {
    const real = await Promise.all(
      this.protectedPaths.map((p) => this.fs.realpath(p).catch(() => p)),
    )
    this.realProtectedPaths = real
  }

  private async entryExists(p: string): Promise<boolean> {
    try {
      await this.fs.lstat(p)
      return true
    } catch {
      return false
    }
  }

  private outsideMessage(input: string): string {
    const roots = this.roots()
    return roots.length === 0
      ? `${input} is outside the granted folders: no folders have been granted yet.`
      : `${input} is outside the granted folders. Granted: ${roots.join(', ')}`
  }
}
