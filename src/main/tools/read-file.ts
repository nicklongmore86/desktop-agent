import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { ToolFailure, ToolInputError, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
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
      'Read a text file inside the granted folders. Returns a one-line header (path, size, line ' +
      'count, range shown) followed by the text. Files over ' +
      `${formatBytes(limits.maxReadBytes)} need startLine/endLine (1-based, inclusive). Binary files ` +
      'are refused. UTF-8, UTF-16 (with BOM) and legacy single-byte encodings are decoded.',
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
      if (!exists) throw new ToolFailure(`File not found: ${file}`)
      const stats = await fs.stat(file)
      if (!stats.isFile()) throw new ToolFailure(`Not a file: ${file}`)
      const ranged = input.startLine !== undefined || input.endLine !== undefined
      const first = input.startLine ?? 1

      if (stats.size > limits.maxReadBytes) {
        if (!ranged) {
          throw new ToolFailure(
            `${file} is ${formatBytes(stats.size)}, over the ${formatBytes(limits.maxReadBytes)} read limit. ` +
              'Pass startLine/endLine to read part of it.',
          )
        }
        return readLargeRange(
          file,
          stats.size,
          first,
          input.endLine,
          limits.maxReadBytes,
          call.ctx.signal,
        )
      }

      const decoded = decodeText(await fs.readFile(file))
      if (decoded.binary) throw new ToolFailure(`${file} looks like a binary file; not reading it.`)
      const lines = splitLines(decoded.text)
      const last = Math.min(input.endLine ?? lines.length, lines.length)
      const encoding = decoded.encoding === 'utf-8' ? '' : ` | ${decoded.encoding}`
      const header = `[${file} | ${formatBytes(stats.size)} | ${String(lines.length)} lines${encoding}`
      if (!ranged) return { content: `${header}]\n${decoded.text}` }
      if (first > lines.length) {
        return { content: `${header} | file has no line ${String(first)}]` }
      }
      const text = lines.slice(first - 1, last).join('\n')
      return { content: `${header} | lines ${String(first)}-${String(last)}]\n${text}` }
    },
  }
}

/** Streams a line range out of a file too big to load, stopping at the byte cap. */
async function readLargeRange(
  file: string,
  size: number,
  first: number,
  last: number | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ content: string }> {
  const handle = await fs.open(file, 'r')
  try {
    const sniff = Buffer.alloc(8000)
    const { bytesRead } = await handle.read(sniff, 0, sniff.length, 0)
    if (looksBinary(sniff.subarray(0, bytesRead))) {
      throw new ToolFailure(`${file} looks like a binary file; not reading it.`)
    }
  } finally {
    await handle.close()
  }

  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const out: string[] = []
  let bytes = 0
  let lineNo = 0
  let capped = false
  try {
    for await (const line of lines) {
      if (signal.aborted) throw new ToolFailure('Cancelled.')
      lineNo++
      if (lineNo < first) continue
      if (last !== undefined && lineNo > last) break
      bytes += Buffer.byteLength(line) + 1
      if (bytes > maxBytes) {
        capped = true
        break
      }
      out.push(line)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  const end = first + out.length - 1
  const range =
    out.length > 0 ? `lines ${String(first)}-${String(end)}` : `no line ${String(first)}`
  const note = capped
    ? `\n[stopped at the ${formatBytes(maxBytes)} limit; continue from line ${String(end + 1)}]`
    : ''
  return { content: `[${file} | ${formatBytes(size)} | ${range}]\n${out.join('\n')}${note}` }
}
