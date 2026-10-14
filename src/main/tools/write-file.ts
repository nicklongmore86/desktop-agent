import { promises as fs } from 'node:fs'
import { ToolFailure, errorResult, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { unifiedDiff } from './diff'
import { decodeText, formatBytes } from './text'

interface Input {
  path: string
  content: string
}

/** The file's current text, or why it cannot be diffed. */
type Existing =
  { kind: 'none' } | { kind: 'text'; text: string; crlf: boolean } | { kind: 'opaque'; why: string }

export function writeFileTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { limits } = deps
  return {
    name: 'write_file',
    description:
      'Create a file or replace its whole content, inside the granted folders. The user sees a diff ' +
      'and must approve every write. Missing parent folders are created. Writes UTF-8; when replacing ' +
      'a file that uses CRLF line endings, LF-only content is converted to CRLF.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file.' },
        content: { type: 'string', description: 'The complete new content of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    needsApproval: true,
    parse: (input) => ({ path: input.string('path'), content: input.string('content') }),
    // Never the content itself: only its size.
    summarize: (input) => ({ path: input.path, bytes: Buffer.byteLength(input.content) }),
    async run(input, call) {
      const size = Buffer.byteLength(input.content)
      if (size > limits.maxWriteBytes) {
        throw new ToolFailure(
          `Content is ${formatBytes(size)}, over the ${formatBytes(limits.maxWriteBytes)} write limit.`,
        )
      }
      const { path: file, exists } = await call.resolve(input.path)
      const existing = exists
        ? await readExisting(file, limits.maxReadBytes)
        : { kind: 'none' as const }

      let content = input.content
      if (existing.kind === 'text' && existing.crlf && !content.includes('\r')) {
        content = content.replace(/\n/g, '\r\n')
      }

      let summary: string
      let detail: string
      if (existing.kind === 'opaque') {
        summary = `Replace ${file} (${existing.why}) with ${formatBytes(Buffer.byteLength(content))} of text`
        detail = `${existing.why}: no diff available.\n\n${unifiedDiff(null, content, file).text}`
      } else {
        const diff = unifiedDiff(existing.kind === 'text' ? existing.text : null, content, file)
        if (existing.kind === 'text' && diff.text === '') {
          return { content: `No change: ${file} already has this content.` }
        }
        const counts = `+${String(diff.added)} -${String(diff.removed)} lines`
        summary =
          existing.kind === 'none' ? `Create ${file} (${counts})` : `Edit ${file} (${counts})`
        detail = diff.text
      }
      if (detail.length > limits.maxDiffBytes) {
        detail = `${detail.slice(0, limits.maxDiffBytes)}\n… diff truncated (${formatBytes(detail.length)} in total)`
      }

      if (!(await call.approve({ kind: 'write', summary, detail }))) {
        return errorResult(`The user declined the write to ${file}. Nothing was changed.`)
      }

      // Re-check after the wait for approval: the path must still resolve to the same place.
      const again = await call.resolve(input.path)
      if (again.path !== file || again.exists !== exists) {
        throw new ToolFailure(`${file} changed while waiting for approval; nothing was written.`)
      }
      await fs.mkdir(deps.guard.path.dirname(file), { recursive: true })
      await fs.writeFile(file, content, 'utf8')
      return {
        content: `${exists ? 'Wrote' : 'Created'} ${file} (${formatBytes(Buffer.byteLength(content))}).`,
      }
    },
  }
}

async function readExisting(file: string, maxBytes: number): Promise<Existing> {
  const stats = await fs.stat(file)
  if (stats.isDirectory()) throw new ToolFailure(`${file} is a folder, not a file.`)
  if (!stats.isFile()) throw new ToolFailure(`${file} is not a regular file.`)
  if (stats.size > maxBytes)
    return { kind: 'opaque', why: `existing file is ${formatBytes(stats.size)}` }
  const decoded = decodeText(await fs.readFile(file))
  if (decoded.binary) return { kind: 'opaque', why: 'existing file is binary' }
  const crlf = /\r\n/.test(decoded.text) && !/(^|[^\r])\n/.test(decoded.text)
  return { kind: 'text', text: decoded.text, crlf }
}
