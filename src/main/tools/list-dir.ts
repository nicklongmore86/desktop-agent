import { promises as fs } from 'node:fs'
import { ToolFailure, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { formatBytes } from './text'
import { walk } from './walk'

interface Input {
  path: string
  depth: number
}

export function listDirTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { limits } = deps
  return {
    name: 'list_dir',
    description:
      'List the contents of a folder inside the granted folders: type, size, last-modified time ' +
      `and path relative to the folder. depth 1 (default) lists direct children; up to ${String(limits.maxListDepth)} ` +
      `recurses. At most ${String(limits.maxListEntries)} entries. Links are listed but not followed; ` +
      'protected files (keys, .env, credentials) are hidden.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the folder.' },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: limits.maxListDepth,
          description: 'How many levels to list (default 1).',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    needsApproval: false,
    parse: (input) => ({
      path: input.string('path'),
      depth: input.optionalInteger('depth', 1, limits.maxListDepth) ?? 1,
    }),
    summarize: (input) => ({ path: input.path, depth: input.depth }),
    async run(input, call) {
      const { path: dir, exists } = await call.resolve(input.path)
      if (!exists || !(await fs.stat(dir)).isDirectory()) {
        throw new ToolFailure(`Not a folder: ${dir}`)
      }

      const lines: string[] = []
      let hidden = 0
      let unreadable = 0
      let truncated = false
      for await (const entry of walk(dir, deps.guard, {
        maxDepth: input.depth,
        signal: call.ctx.signal,
        onBlocked: () => hidden++,
        onUnreadable: () => unreadable++,
      })) {
        if (lines.length >= limits.maxListEntries) {
          truncated = true
          break
        }
        const size = entry.kind === 'file' ? formatBytes(entry.size) : '-'
        const mtime = new Date(entry.mtimeMs).toISOString().slice(0, 19) + 'Z'
        const name = entry.kind === 'dir' ? `${entry.rel}/` : entry.rel
        lines.push(`${entry.kind.padEnd(7)} ${size.padStart(9)}  ${mtime}  ${name}`)
      }
      call.throwIfAborted()

      const notes: string[] = []
      if (truncated)
        notes.push(
          `Stopped at ${String(limits.maxListEntries)} entries; list a subfolder or use a smaller depth.`,
        )
      if (hidden > 0) notes.push(`${String(hidden)} protected entries hidden.`)
      if (unreadable > 0) notes.push(`${String(unreadable)} folders could not be read.`)
      const header = `${dir} (${String(lines.length)} entries)`
      return {
        content: [header, ...(lines.length > 0 ? lines : ['(empty)']), ...notes].join('\n'),
      }
    },
  }
}
