import { promises as fs } from 'node:fs'
import { isInside, samePath } from '../permissions/paths'
import { ToolFailure, errorResult, type ToolCall, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { assertSingleLink, copyHandle, openVerified, sameIdentity } from './safe-fs'
import { assertNoBlockedInside } from './walk'

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
      await assertNoBlockedInside(source.path, guard, limits.maxScanEntries, call.ctx.signal)
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
   * Moves a regular file while holding a verified handle to it, so a file
   * swapped in after the last check is caught: after the rename the
   * destination must be the very file that was opened, still with a single
   * link, or it is renamed back. Across volumes the copy is made from the
   * handle, never by path.
   */
  async function moveVerifiedFile(
    source: string,
    destination: string,
    replaces: boolean,
  ): Promise<void> {
    const { handle, stats } = await openVerified(guard, source, 'read')
    try {
      try {
        await fs.rename(source, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        const target = await openVerified(guard, destination, replaces ? 'update' : 'create')
        try {
          await copyHandle(handle, target.handle)
        } finally {
          await target.handle.close()
        }
        const left = await fs.lstat(source, { bigint: true })
        if (!sameIdentity(left, stats)) {
          throw movedChanged(source, `a copy is at ${destination}; the original was left in place`)
        }
        await fs.rm(source)
        return
      }
      const moved = await fs.lstat(destination, { bigint: true })
      const now = await handle.stat({ bigint: true })
      if (!sameIdentity(moved, stats) || now.nlink > 1n) {
        const restored = await fs.rename(destination, source).then(
          () => true,
          () => false,
        )
        throw movedChanged(
          source,
          restored ? 'it was put back' : `what was moved is now at ${destination}`,
        )
      }
    } finally {
      await handle.close()
    }
  }
}

function movedChanged(path: string, outcome: string): ToolFailure {
  return new ToolFailure(`${path} changed while it was being moved; ${outcome}.`, 'changed')
}
