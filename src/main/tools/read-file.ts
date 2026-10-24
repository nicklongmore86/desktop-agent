import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { KIND_LABEL, sniff } from '../documents/sniff'
import { ToolFailure, ToolInputError, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { readableAsDocument } from './read-document'
import { openVerified, readBounded } from './safe-fs'
import { decodeText, formatBytes, looksBinary, splitLines } from './text'

interface Input {
  path: string
  startLine: number | undefined
  endLine: number | undefined
}

const MAX_LINE = 10_000_000

export function readFileTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { limits } = deps
  return {
    name: 'read_file',
    description:
      'Read a text file inside the granted folders (for PDFs and images, use read_document). Returns a one-line header (path, size, line ' +
      'count, range shown) followed by the text. Files over ' +
      `${formatBytes(limits.maxReadBytes)} need startLine/endLine (1-based, inclusive). Binary files ` +
      'and files with several hard links are refused. UTF-8, UTF-16 (with BOM) and legacy ' +
      'single-byte encodings are decoded.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file.' },
        startLine: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
        endLine: { type: 'integer', minimum: 1, description: 'Last line to return (inclusive).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    needsApproval: false,
    parse(input) {
      const startLine = input.optionalInteger('startLine', 1, MAX_LINE)
      const endLine = input.optionalInteger('endLine', 1, MAX_LINE)
      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        throw new ToolInputError('"endLine" must not be before "startLine".')
      }
      return { path: input.string('path'), startLine, endLine }
    },
    summarize: (input) => ({
      path: input.path,
      ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
      ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
    }),
    async run(input, call) {
      const { path: file, exists } = await call.resolve(input.path)
      if (!exists) throw new ToolFailure(`File not found: ${file}`, 'not-found')
      if (!(await fs.stat(file)).isFile())
        throw new ToolFailure(`Not a file: ${file}`, 'not-a-file')
      // Everything below reads through this handle, which is proven to be the guarded file.
      const { handle, stats } = await openVerified(deps.guard, file, 'read')
      try {
        const size = Number(stats.size)
        const ranged = input.startLine !== undefined || input.endLine !== undefined
        const first = input.startLine ?? 1

        if (size > limits.maxReadBytes) {
          if (!ranged) {
            throw new ToolFailure(
              `${file} is ${formatBytes(size)}, over the ${formatBytes(limits.maxReadBytes)} read limit. ` +
                'Pass startLine/endLine to read part of it.',
              'too-large',
            )
          }
          const head = await readBounded(handle, 8000)
          if (looksBinary(head)) throw binaryFailure(file, head)
          const range = await readLineRange(
            handle,
            first,
            input.endLine,
            limits.maxReadBytes,
            call.ctx.signal,
          )
          return { content: `[${file} | ${formatBytes(size)} | ${range.header}]\n${range.text}` }
        }

        const bytes = await readBounded(handle, limits.maxReadBytes)
        const decoded = decodeText(bytes)
        if (decoded.binary) throw binaryFailure(file, bytes)
        const lines = splitLines(decoded.text)
        const last = Math.min(input.endLine ?? lines.length, lines.length)
        const encoding = decoded.encoding === 'utf-8' ? '' : ` | ${decoded.encoding}`
        const header = `[${file} | ${formatBytes(size)} | ${String(lines.length)} lines${encoding}`
        if (!ranged) return { content: `${header}]\n${decoded.text}` }
        if (first > lines.length) {
          return { content: `${header} | file has no line ${String(first)}]` }
        }
        const text = lines.slice(first - 1, last).join('\n')
        return { content: `${header} | lines ${String(first)}-${String(last)}]\n${text}` }
      } finally {
        await handle.close()
      }
    },
  }
}

/** The binary refusal, pointing to read_document when it can read the file. */
function binaryFailure(file: string, head: Uint8Array): ToolFailure {
  const { kind } = sniff(head)
  if (readableAsDocument(kind)) {
    return new ToolFailure(
      `${file} is a ${KIND_LABEL[kind]}, not text; use read_document to read it.`,
      'binary',
    )
  }
  return new ToolFailure(`${file} looks like a binary file; not reading it.`, 'binary')
}

const CHUNK = 64 * 1024

/**
 * Reads lines `first`..`last` of a file too big to load, in fixed-size
 * chunks. Only bytes of lines in the range are kept, and never more than
 * `maxBytes` in total: a single enormous line is cut at the cap rather than
 * buffered whole.
 */
export async function readLineRange(
  handle: FileHandle,
  first: number,
  last: number | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ header: string; text: string }> {
  const lines: string[] = []
  let current: Buffer[] = []
  let currentBytes = 0
  let used = 0
  let lineNo = 1
  let position = 0
  let cutLine: number | null = null
  let capped = false
  const chunk = Buffer.alloc(CHUNK)
  const inRange = () => lineNo >= first && (last === undefined || lineNo <= last)
  const finishLine = () => {
    lines.push(Buffer.concat(current).toString('utf8').replace(/\r$/, ''))
    used += currentBytes + 1
    current = []
    currentBytes = 0
  }

  reading: for (;;) {
    if (signal.aborted) throw new ToolFailure('Cancelled.', 'cancelled')
    const { bytesRead } = await handle.read(chunk, 0, CHUNK, position)
    if (bytesRead === 0) {
      if (inRange() && currentBytes > 0) finishLine()
      break
    }
    position += bytesRead
    const data = chunk.subarray(0, bytesRead)
    let start = 0
    for (;;) {
      const newline = data.indexOf(10, start)
      const piece = data.subarray(start, newline === -1 ? data.length : newline)
      if (inRange()) {
        const room = maxBytes - used - currentBytes
        if (piece.length > room) {
          if (lines.length > 0) {
            // Stop cleanly before this line; the model can continue from it.
            capped = true
            break reading
          }
          // A single line bigger than the whole cap: show its start only.
          current.push(Buffer.from(piece.subarray(0, Math.max(0, room))))
          currentBytes += Math.max(0, room)
          finishLine()
          cutLine = lineNo
          break reading
        }
        current.push(Buffer.from(piece))
        currentBytes += piece.length
      }
      if (newline === -1) break
      if (inRange()) finishLine()
      lineNo++
      start = newline + 1
      if (last !== undefined && lineNo > last) break reading
      if (inRange() && used >= maxBytes) {
        capped = true
        break reading
      }
    }
  }

  if (lines.length === 0) return { header: `no line ${String(first)}`, text: '' }
  const end = first + lines.length - 1
  let note = ''
  if (cutLine !== null) {
    note = `\n[line ${String(cutLine)} is cut at the ${formatBytes(maxBytes)} limit]`
  } else if (capped) {
    note = `\n[stopped at the ${formatBytes(maxBytes)} limit; continue from line ${String(end + 1)}]`
  }
  return { header: `lines ${String(first)}-${String(end)}`, text: `${lines.join('\n')}${note}` }
}
