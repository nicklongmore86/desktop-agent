import { promises as fs } from 'node:fs'
import type { PathGuard } from '../permissions/guard'
import { ToolFailure, errorResult, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { unifiedDiff } from './diff'
import { hashHandle, openVerified, overwriteHandle, readBounded, type Identity } from './safe-fs'
import { decodeText, formatBytes } from './text'

interface Input {
  path: string
  content: string
}

/** The file's current text, or why it cannot be diffed. */
type Existing =
  { kind: 'none' } | { kind: 'text'; text: string; crlf: boolean } | { kind: 'opaque'; why: string }

/**
 * What the user reviewed. The write goes ahead only if the file is still
 * exactly this: same existence, inode, size, mtime and content hash.
 */
type Baseline =
  { exists: false } | { exists: true; id: Identity; size: bigint; mtimeNs: bigint; sha256: string }

export function writeFileTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { guard, limits } = deps
  return {
    name: 'write_file',
    description:
      'Create a file or replace its whole content, inside the granted folders. The user sees the ' +
      'complete diff and must approve every write; if the file changes before they answer, nothing ' +
      `is written. Diffs over ${formatBytes(limits.maxDiffBytes)} are refused: make smaller edits. ` +
      'Missing parent folders are created. Writes UTF-8; when replacing a file that uses CRLF line ' +
      'endings, LF-only content is converted to CRLF.',
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
          'too-large',
        )
      }
      const { path: file, exists } = await call.resolve(input.path)
      const { existing, baseline } = exists
        ? await readExisting(guard, file, limits.maxReadBytes)
        : { existing: { kind: 'none' as const }, baseline: { exists: false as const } }

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
      // The user must be able to see everything they approve, so the preview is never cut.
      const detailBytes = Buffer.byteLength(detail)
      if (detailBytes > limits.maxDiffBytes) {
        throw new ToolFailure(
          `The diff for ${file} is ${formatBytes(detailBytes)}, over the ${formatBytes(limits.maxDiffBytes)} ` +
            'the user can review. Nothing was written; make smaller edits (or split the file).',
          'too-large',
        )
      }

      if (!(await call.approve({ kind: 'write', summary, detail }))) {
        return errorResult(
          `The user declined the write to ${file}. Nothing was changed.`,
          'declined',
        )
      }

      // The approval covers what was shown: the path must resolve to the same place and the
      // file must be exactly as it was when the diff was built.
      const again = await call.resolve(input.path)
      if (again.path !== file || again.exists !== exists) throw changedSinceReview(file)
      const data = Buffer.from(content, 'utf8')
      if (baseline.exists) {
        const { handle, stats } = await openVerified(guard, file, 'update', baseline.id)
        try {
          if (
            stats.size !== baseline.size ||
            stats.mtimeNs !== baseline.mtimeNs ||
            (await hashHandle(handle)) !== baseline.sha256
          ) {
            throw changedSinceReview(file)
          }
          await overwriteHandle(handle, data)
        } finally {
          await handle.close()
        }
      } else {
        await fs.mkdir(guard.path.dirname(file), { recursive: true })
        // Exclusive create: fails if anything (file or link) appeared at the path meanwhile.
        let opened: Awaited<ReturnType<typeof openVerified>>
        try {
          opened = await openVerified(guard, file, 'create')
        } catch (error) {
          if (error instanceof ToolFailure && error.code === 'changed')
            throw changedSinceReview(file)
          throw error
        }
        try {
          await overwriteHandle(opened.handle, data)
        } finally {
          await opened.handle.close()
        }
      }
      return {
        content: `${exists ? 'Wrote' : 'Created'} ${file} (${formatBytes(data.length)}).`,
      }
    },
  }
}

function changedSinceReview(file: string): ToolFailure {
  return new ToolFailure(
    `${file} changed after the diff was shown to the user; nothing was written. Read it again and retry.`,
    'changed',
  )
}

/** Existing files are hashed in full for the baseline; bigger ones are not replaced. */
const MAX_REPLACE_BYTES = 64 * 1024 * 1024

/** Reads the current file through a verified handle: its text for the diff, and the baseline. */
async function readExisting(
  guard: PathGuard,
  file: string,
  maxBytes: number,
): Promise<{ existing: Existing; baseline: Baseline }> {
  if ((await fs.stat(file)).isDirectory()) {
    throw new ToolFailure(`${file} is a folder, not a file.`, 'not-a-file')
  }
  const { handle, stats } = await openVerified(guard, file, 'read')
  try {
    if (stats.size > BigInt(MAX_REPLACE_BYTES)) {
      throw new ToolFailure(
        `${file} is ${formatBytes(Number(stats.size))}; replacing files over ` +
          `${formatBytes(MAX_REPLACE_BYTES)} is not supported.`,
        'too-large',
      )
    }
    const baseline: Baseline = {
      exists: true,
      id: { dev: stats.dev, ino: stats.ino },
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      sha256: await hashHandle(handle),
    }
    if (stats.size > BigInt(maxBytes)) {
      return {
        existing: { kind: 'opaque', why: `existing file is ${formatBytes(Number(stats.size))}` },
        baseline,
      }
    }
    const decoded = decodeText(await readBounded(handle, maxBytes))
    if (decoded.binary)
      return { existing: { kind: 'opaque', why: 'existing file is binary' }, baseline }
    const crlf = /\r\n/.test(decoded.text) && !/(^|[^\r])\n/.test(decoded.text)
    return { existing: { kind: 'text', text: decoded.text, crlf }, baseline }
  } finally {
    await handle.close()
  }
}
