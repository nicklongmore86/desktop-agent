import { promises as fs } from 'node:fs'
import { ToolFailure, errorResult, type ToolCall, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { assertNoBlockedInside } from './walk'

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
      const summary = `Move ${plan.kind} ${plan.path} to the Recycle Bin`
      if (!(await call.approve({ kind: 'delete', summary, detail: plan.path }))) {
        return errorResult(`The user declined deleting ${plan.path}. Nothing was changed.`)
      }
      const again = await planDelete(input, call)
      if (again.path !== plan.path || again.kind !== plan.kind) {
        throw new ToolFailure(
          `${plan.path} changed while waiting for approval; nothing was deleted.`,
        )
      }
      try {
        await deps.trash(plan.path)
      } catch (error) {
        throw new ToolFailure(
          `Could not move ${plan.path} to the Recycle Bin: ${(error as Error).message}. Nothing was deleted.`,
        )
      }
      return { content: `Moved ${plan.path} to the Recycle Bin.` }
    },
  }

  async function planDelete(input: Input, call: ToolCall): Promise<{ path: string; kind: string }> {
    const target = await call.resolve(input.path, { followFinalSymlink: false })
    if (!target.exists) throw new ToolFailure(`Not found: ${target.path}`)
    if (guard.containsRoot(target.path)) {
      throw new ToolFailure(`${target.path} is or contains a granted folder and cannot be deleted.`)
    }
    const stats = await fs.lstat(target.path)
    if (stats.isDirectory()) {
      await assertNoBlockedInside(target.path, guard, limits.maxScanEntries, call.ctx.signal)
      call.throwIfAborted()
      return { path: target.path, kind: 'folder' }
    }
    return { path: target.path, kind: stats.isSymbolicLink() ? 'link' : 'file' }
  }
}
