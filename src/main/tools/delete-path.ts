import { promises as fs } from 'node:fs'
import { ToolFailure, errorResult, type ToolCall, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { assertSingleLink, openVerified } from './safe-fs'
import { MAX_TREE_CHECK_MS, assertNoBlockedInside } from './walk'

interface Input {
  path: string
}

export function deletePathTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { guard, limits } = deps
  return {
    name: 'delete_path',
    description:
      'Move a file or folder inside the granted folders to the Recycle Bin (never a permanent ' +
      "delete). Requires the user's approval. A link is removed itself, not its target.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file or folder.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    needsApproval: true,
    parse: (input) => ({ path: input.string('path') }),
    summarize: (input) => ({ ...input }),
    async run(input, call) {
      const plan = await planDelete(input, call)
      const summary = `Move ${plan.kind} ${plan.path}${describeContents(plan.entries)} to the Recycle Bin`
      if (!(await call.approve({ kind: 'delete', summary, detail: plan.path }))) {
        return errorResult(
          `The user declined deleting ${plan.path}. Nothing was changed.`,
          'declined',
        )
      }
      const again = await planDelete(input, call)
      // The user approved this many items: a folder that gained or lost some is not what they saw.
      if (again.path !== plan.path || again.kind !== plan.kind || again.entries !== plan.entries) {
        throw new ToolFailure(
          `${plan.path} changed while waiting for approval; nothing was deleted.`,
          'changed',
        )
      }
      try {
        await deps.trash(plan.path)
      } catch (error) {
        throw new ToolFailure(
          `Could not move ${plan.path} to the Recycle Bin: ${(error as Error).message}. Nothing was deleted.`,
          'failed',
        )
      }
      return { content: `Moved ${plan.path} to the Recycle Bin.` }
    },
  }

  async function planDelete(
    input: Input,
    call: ToolCall,
  ): Promise<{ path: string; kind: string; entries: number | null }> {
    const target = await call.resolve(input.path, { followFinalSymlink: false })
    if (!target.exists) throw new ToolFailure(`Not found: ${target.path}`, 'not-found')
    if (guard.containsRoot(target.path)) {
      throw new ToolFailure(
        `${target.path} is or contains a granted folder and cannot be deleted.`,
        'protected',
      )
    }
    const stats = await fs.lstat(target.path)
    if (stats.isDirectory()) {
      const { entries } = await assertNoBlockedInside(
        target.path,
        guard,
        limits.maxScanEntries,
        call.ctx.signal,
        { ms: MAX_TREE_CHECK_MS, now: deps.now },
      )
      call.throwIfAborted()
      return { path: target.path, kind: 'folder', entries }
    }
    if (stats.isFile()) {
      const { handle } = await openVerified(guard, target.path, 'read')
      await handle.close()
      return { path: target.path, kind: 'file', entries: null }
    }
    assertSingleLink(target.path, await fs.lstat(target.path, { bigint: true }))
    return { path: target.path, kind: stats.isSymbolicLink() ? 'link' : 'file', entries: null }
  }
}

/** The exact count of what goes with a folder (every entry was walked to check it). */
function describeContents(entries: number | null): string {
  if (entries === null) return ''
  if (entries === 0) return ' (empty)'
  const n = entries.toLocaleString('en-US')
  return ` and the ${n} ${entries === 1 ? 'item' : 'items'} inside it`
}
