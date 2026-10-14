import { promises as fs } from 'node:fs'
import { blocklistReason } from './blocklist'
import { checkPathSyntax, isInside, pathApi, samePath } from './paths'

interface GrantsFile {
  version: 1
  roots: string[]
}

export interface GrantStoreOptions {
  platform?: NodeJS.Platform
  /** Paths that may never be granted, nor anything inside them (the app's userData). */
  protectedPaths?: readonly string[]
}

export type AddGrantResult = { ok: true; root: string } | { ok: false; reason: string }

function isGrantsFile(value: unknown): value is GrantsFile {
  if (typeof value !== 'object' || value === null) return false
  const roots = (value as { roots?: unknown }).roots
  return Array.isArray(roots) && roots.every((r) => typeof r === 'string')
}

/**
 * The folders the user has granted the agent access to, persisted as JSON
 * (`{ "version": 1, "roots": [...] }`). Roots are stored as real paths, so a
 * granted folder that is later swapped for a link stops matching (see PathGuard).
 */
export class GrantStore {
  private constructor(
    private readonly file: string,
    private roots: string[],
    private readonly platform: NodeJS.Platform,
    private readonly protectedPaths: readonly string[],
    /** Set when the file existed but could not be read; the store then starts empty. */
    readonly loadError: string | null,
  ) {}

  /**
   * Loads the store from `file`. A missing file means no grants. An unreadable
   * or malformed file also means no grants (fail closed) and sets `loadError`;
   * the file is left alone until the next add or remove rewrites it.
   */
  static async open(file: string, options: GrantStoreOptions = {}): Promise<GrantStore> {
    const platform = options.platform ?? process.platform
    const protectedPaths = options.protectedPaths ?? []
    let roots: string[] = []
    let loadError: string | null = null
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      if (isGrantsFile(parsed)) roots = parsed.roots
      else loadError = `${file} is not a valid grants file.`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        loadError = `Could not read ${file}: ${(error as Error).message}`
      }
    }
    return new GrantStore(file, roots, platform, protectedPaths, loadError)
  }

  list(): readonly string[] {
    return [...this.roots]
  }

  /** Grants `folder` (must be an existing local directory) and persists the change. */
  async add(folder: string): Promise<AddGrantResult> {
    const P = pathApi(this.platform)
    const syntax = checkPathSyntax(folder, this.platform)
    if (syntax) return { ok: false, reason: syntax }

    let real: string
    try {
      real = await fs.realpath(P.resolve(folder))
      if (!(await fs.stat(real)).isDirectory()) {
        return { ok: false, reason: `${folder} is not a folder.` }
      }
    } catch {
      return { ok: false, reason: `${folder} does not exist or cannot be accessed.` }
    }

    const realSyntax = checkPathSyntax(real, this.platform)
    if (realSyntax) return { ok: false, reason: realSyntax }
    if (P.parse(real).root === real) {
      return { ok: false, reason: `Granting a whole drive or file system root is not allowed.` }
    }
    const blocked = blocklistReason(real, this.platform)
    if (blocked) return { ok: false, reason: blocked }
    for (const protectedPath of this.protectedPaths) {
      const lexical = P.resolve(protectedPath)
      const realProtected = await fs.realpath(lexical).catch(() => lexical)
      if (isInside(real, lexical, this.platform) || isInside(real, realProtected, this.platform)) {
        return { ok: false, reason: `${folder} is part of the app's own data.` }
      }
    }

    if (!this.roots.some((root) => samePath(root, real, this.platform))) {
      this.roots = [...this.roots, real]
      await this.save()
    }
    return { ok: true, root: real }
  }

  /** Revokes a granted root. Returns false when it was not granted. */
  async remove(folder: string): Promise<boolean> {
    const P = pathApi(this.platform)
    const target = P.resolve(folder)
    const remaining = this.roots.filter((root) => !samePath(root, target, this.platform))
    if (remaining.length === this.roots.length) return false
    this.roots = remaining
    await this.save()
    return true
  }

  private async save(): Promise<void> {
    const P = pathApi(this.platform)
    const data: GrantsFile = { version: 1, roots: this.roots }
    await fs.mkdir(P.dirname(this.file), { recursive: true })
    // Write then rename so a crash never leaves a half-written file.
    const temp = `${this.file}.${String(process.pid)}.tmp`
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await fs.rename(temp, this.file)
  }
}
