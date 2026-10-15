import { randomBytes } from 'node:crypto'
import { promises as fs, type BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isInside, samePath } from '../permissions/paths'
import { ToolFailure, errorResult, type ToolCall, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { assertSingleLink, copyHandle, openVerified, sameIdentity, type Identity } from './safe-fs'
import { MAX_TREE_CHECK_MS, assertNoBlockedInside } from './walk'

interface Input {
  source: string
  destination: string
  overwrite: boolean
}

export function moveFileTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { guard, limits, platform } = deps
  return {
    name: 'move_file',
    description:
      'Move or rename a file or folder; both paths must be inside the granted folders. Requires the ' +
      "user's approval. Fails if the destination exists unless overwrite is true (files only). " +
      'A link is moved itself, not its target.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path of the file or folder to move.' },
        destination: { type: 'string', description: 'Absolute path it should have afterwards.' },
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing destination file (default false).',
        },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    },
    needsApproval: true,
    parse: (input) => ({
      source: input.string('source'),
      destination: input.string('destination'),
      overwrite: input.optionalBoolean('overwrite') ?? false,
    }),
    summarize: (input) => ({ ...input }),
    async run(input, call) {
      const plan = await planMove(input, call)
      const summary = `Move ${plan.source} to ${plan.destination}${plan.replaces ? ' (replacing it)' : ''}`
      if (
        !(await call.approve({
          kind: 'move',
          summary,
          detail: `${plan.source}\n→ ${plan.destination}`,
        }))
      ) {
        return errorResult(
          `The user declined moving ${plan.source}. Nothing was changed.`,
          'declined',
        )
      }
      const again = await planMove(input, call)
      if (
        again.source !== plan.source ||
        again.destination !== plan.destination ||
        again.replaces !== plan.replaces ||
        again.isFile !== plan.isFile
      ) {
        throw new ToolFailure(
          'The paths changed while waiting for approval; nothing was moved.',
          'changed',
        )
      }

      await fs.mkdir(guard.path.dirname(plan.destination), { recursive: true })
      if (plan.isFile) {
        await moveVerifiedFile(plan.source, plan.destination, plan.replaces)
      } else {
        try {
          await fs.rename(plan.source, plan.destination)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
          // Different volume: copy, then remove the original (the copy is already in place).
          await fs.cp(plan.source, plan.destination, {
            recursive: true,
            force: plan.replaces,
            errorOnExist: !plan.replaces,
            verbatimSymlinks: true,
          })
          await fs.rm(plan.source, { recursive: true })
        }
      }
      return { content: `Moved ${plan.source} to ${plan.destination}.` }
    },
  }

  async function planMove(
    input: Input,
    call: ToolCall,
  ): Promise<{ source: string; destination: string; replaces: boolean; isFile: boolean }> {
    const source = await call.resolve(input.source, { followFinalSymlink: false })
    if (!source.exists) throw new ToolFailure(`Not found: ${source.path}`, 'not-found')
    if (guard.containsRoot(source.path)) {
      throw new ToolFailure(
        `${source.path} is or contains a granted folder and cannot be moved.`,
        'protected',
      )
    }
    const destination = await call.resolve(input.destination, { followFinalSymlink: false })
    if (destination.path === source.path)
      throw new ToolFailure('Source and destination are the same.', 'invalid-input')
    // A case-only rename on Windows/macOS resolves to the same entry: not an overwrite.
    const sameEntry = samePath(destination.path, source.path, platform)
    if (!sameEntry && isInside(destination.path, source.path, platform)) {
      throw new ToolFailure('Cannot move a folder into itself.', 'invalid-input')
    }
    const sourceStats = await fs.lstat(source.path)
    if (sourceStats.isDirectory()) {
      await assertNoBlockedInside(source.path, guard, limits.maxScanEntries, call.ctx.signal, {
        ms: MAX_TREE_CHECK_MS,
        now: deps.now,
      })
    } else {
      await assertMovableEntry(source.path, sourceStats.isFile())
    }
    let replaces = false
    if (destination.exists && !sameEntry) {
      if (!input.overwrite) {
        throw new ToolFailure(`${destination.path} already exists.`, 'exists')
      }
      const destStats = await fs.lstat(destination.path)
      if (destStats.isDirectory() || sourceStats.isDirectory()) {
        throw new ToolFailure('overwrite only replaces a file with a file.', 'invalid-input')
      }
      await assertMovableEntry(destination.path, destStats.isFile())
      replaces = true
    }
    return {
      source: source.path,
      destination: destination.path,
      replaces,
      isFile: sourceStats.isFile(),
    }
  }

  /** A regular file must open as itself and have no other hard links; links are checked by lstat. */
  async function assertMovableEntry(path: string, isFile: boolean): Promise<void> {
    if (!isFile) {
      assertSingleLink(path, await fs.lstat(path, { bigint: true }))
      return
    }
    const { handle } = await openVerified(guard, path, 'read')
    await handle.close()
  }

  /**
   * Moves a regular file while holding a verified handle to it, so a swap after
   * the last check is caught and nothing the user owns is lost or clobbered:
   * - an existing destination is first renamed aside (same folder) and is only
   *   removed once the move is proven; on failure it is put back if its place
   *   is still free, otherwise the error says where it is;
   * - nothing is ever renamed onto a path that is occupied (checked just before);
   * - after a rename the destination must be the very inode that was opened,
   *   still with a single link; a foreign file found there is left alone;
   * - across volumes the copy is made from the handle and kept only if the
   *   source did not change while it was copied.
   */
  async function moveVerifiedFile(
    source: string,
    destination: string,
    replaces: boolean,
  ): Promise<void> {
    const { handle, stats } = await openVerified(guard, source, 'read')
    let aside: Placed | null = null
    try {
      if (replaces) aside = await setAside(destination)
      await moveHeldFile(handle, stats, source, destination)
    } catch (error) {
      if (!aside || (await renameNoClobber(aside.path, destination))) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new ToolFailure(
        `${message} The file that was at ${destination} could not be put back (the path is ` +
          `taken) and is now at ${aside.path}.`,
        'changed',
      )
    } finally {
      await handle.close()
    }
    // Proven moved: only now is the replaced file thrown away.
    if (aside) await removeIfSame(aside.path, aside.id)
  }

  async function moveHeldFile(
    handle: FileHandle,
    stats: BigIntStats,
    source: string,
    destination: string,
  ): Promise<void> {
    // Last checks before the move: still the opened file with one link, and (unless it is only
    // a case change of the same entry) nothing has appeared at the destination.
    assertSingleLink(source, await handle.stat({ bigint: true }))
    if (!(await isEntry(source, stats))) throw movedChanged(source, 'nothing was moved')
    if (!samePath(source, destination, platform) && (await occupied(destination))) {
      throw movedChanged(destination, 'nothing was moved')
    }
    try {
      await fs.rename(source, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await copyAcrossVolumes(handle, stats, source, destination)
      return
    }
    if (!(await isEntry(destination, stats))) {
      // What was renamed is not the file that was checked: something was swapped in. It is
      // not ours to move again, so it stays where it is.
      throw new ToolFailure(
        `${source} was replaced by something else just before the move; that is now at ` +
          `${destination} and was left there. Nothing else was moved.`,
        'changed',
      )
    }
    if ((await handle.stat({ bigint: true })).nlink > 1n) {
      // Our own file gained another name mid-move: undo, but never onto an occupied path.
      if (await renameNoClobber(destination, source)) {
        throw movedChanged(source, 'it was moved back')
      }
      throw new ToolFailure(
        `${source} gained another hard link while it was being moved. It is at ${destination}: ` +
          `it could not be moved back because ${source} is taken again.`,
        'changed',
      )
    }
  }

  /** Copies from the held handle into a new destination; keeps the copy only if the source held still. */
  async function copyAcrossVolumes(
    handle: FileHandle,
    stats: BigIntStats,
    source: string,
    destination: string,
  ): Promise<void> {
    const target = await openVerified(guard, destination, 'create')
    let copied: bigint
    try {
      copied = await copyHandle(handle, target.handle) // synced before it returns
    } catch (error) {
      await target.handle.close()
      await removeIfSame(destination, target.stats)
      throw error
    }
    await target.handle.close()
    const now = await handle.stat({ bigint: true })
    const unchanged =
      sameIdentity(now, stats) &&
      now.nlink === 1n &&
      now.size === stats.size &&
      now.mtimeNs === stats.mtimeNs &&
      copied === stats.size &&
      (await isEntry(source, stats))
    if (!unchanged) {
      const removed = await removeIfSame(destination, target.stats)
      throw new ToolFailure(
        `${source} changed while it was being copied to ${destination}; the original was left ` +
          'in place and ' +
          (removed
            ? 'the copy was removed.'
            : `${destination} was left as it is (it is no longer the copy that was made).`),
        'changed',
      )
    }
    if (!(await removeIfSame(source, stats))) {
      throw new ToolFailure(
        `${source} was copied to ${destination}, but it changed just before the original was ` +
          'to be removed, so it was left in place.',
        'changed',
      )
    }
  }

  /** Renames an existing destination file out of the way, to a unique name in its folder. */
  async function setAside(destination: string): Promise<Placed> {
    const before = await fs.lstat(destination, { bigint: true })
    if (!before.isFile()) throw movedChanged(destination, 'nothing was moved')
    assertSingleLink(destination, before)
    const path = guard.path.join(
      guard.path.dirname(destination),
      `.${guard.path.basename(destination)}.${randomBytes(6).toString('hex')}.replaced`,
    )
    if (!(await renameNoClobber(destination, path))) {
      throw movedChanged(destination, 'nothing was moved')
    }
    if (!(await isEntry(path, before))) {
      // Swapped between the lstat and the rename: put it back as found and stop.
      await renameNoClobber(path, destination)
      throw movedChanged(destination, 'nothing was moved')
    }
    return { path, id: { dev: before.dev, ino: before.ino } }
  }
}

interface Placed {
  path: string
  id: Identity
}

function movedChanged(path: string, outcome: string): ToolFailure {
  return new ToolFailure(`${path} changed while it was being moved; ${outcome}.`, 'changed')
}

/** Whether anything (file, folder or link) is at `path`. Unknown counts as taken. */
async function occupied(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** Whether the entry at `path` (not following links) is the given inode. */
async function isEntry(path: string, id: Identity): Promise<boolean> {
  try {
    return sameIdentity(await fs.lstat(path, { bigint: true }), id)
  } catch {
    return false
  }
}

/**
 * Renames only if nothing is at `to`, checked immediately before (Node has no
 * no-replace rename, so a racing create in between remains possible).
 */
async function renameNoClobber(from: string, to: string): Promise<boolean> {
  if (await occupied(to)) return false
  try {
    await fs.rename(from, to)
    return true
  } catch {
    return false
  }
}

/** Removes `path` only if it is still the given inode. */
async function removeIfSame(path: string, id: Identity): Promise<boolean> {
  if (!(await isEntry(path, id))) return false
  try {
    await fs.rm(path)
    return true
  } catch {
    return false
  }
}
