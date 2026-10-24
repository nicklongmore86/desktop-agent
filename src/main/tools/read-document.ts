import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_LIMITS as DOCUMENT_LIMITS } from '../documents/limits'
import { KIND_LABEL } from '../documents/sniff'
import {
  DocumentError,
  type DocumentErrorCode,
  type DocumentKind,
  type DocumentView,
  type ExtractOptions,
  type PageRegion,
} from '../documents/types'
import { ToolFailure, ToolInputError, type ErrorCode, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { openVerified, readBounded } from './safe-fs'
import { formatBytes } from './text'
import type { ToolImage } from './types'

interface Input {
  path: string
  /** A 1-based inclusive page range. */
  from: number | undefined
  to: number | undefined
  /** Where to continue: the page a previous call named. */
  start: number | undefined
  region: PageRegion | undefined
  includeLocation: boolean
}

/** Kinds read_document reads today (the worker decodes these). */
const READABLE = new Set<DocumentKind>(['pdf', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'])

/** Whether read_document can read a file of this kind; read_file points binary files there. */
export function readableAsDocument(kind: DocumentKind): boolean {
  return READABLE.has(kind)
}

const MAX_PAGE = 1_000_000

/** The audit category for each reader refusal. */
const ERROR_CODES: Record<DocumentErrorCode, ErrorCode> = {
  'too-large': 'too-large',
  'too-many-pixels': 'too-large',
  'password-protected': 'unreadable',
  malformed: 'unreadable',
  'zip-bomb': 'unreadable',
  unsupported: 'unsupported',
  'out-of-range': 'out-of-range',
  timeout: 'timeout',
  memory: 'worker-failed',
  'worker-failed': 'worker-failed',
}

export function readDocumentTool(deps: ResolvedDeps): ToolSpec<Input> {
  return {
    name: 'read_document',
    description:
      'Read a PDF or an image (JPEG, PNG, GIF, WebP, BMP, TIFF) inside the granted folders. ' +
      'Returns a header (path, type, size, pages and the range shown) and the text page by ' +
      'page; pages that are drawings or scans, and photos, also come back as images. Long ' +
      `documents are read up to ${String(DOCUMENT_LIMITS.maxPagesPerCall)} pages (and a text ` +
      'budget) at a time: the last line says where to continue with `start`. Use `region` to ' +
      `zoom into part of a page (up to ${String(DOCUMENT_LIMITS.maxRegionScale)}x) for small ` +
      'print or drawing detail. Photos are returned upright with their metadata removed; the ' +
      'capture time and camera come back as text, the location only with include_location. Office ' +
      'documents, HEIC and AVIF are not supported yet. Use read_file for text files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file.' },
        pages: {
          type: 'string',
          description:
            'Pages to read, 1-based: "3", "2-5" or "10-" (to the end, within the limit).',
        },
        start: {
          type: 'integer',
          minimum: 1,
          description: 'Continue from this page: the one a previous call named.',
        },
        region: {
          type: 'object',
          description:
            'Re-render part of one page larger. x, y, width and height are fractions (0 to 1) ' +
            'of the page from its top left, e.g. {"page": 2, "x": 0.5, "y": 0.5, "width": 0.5, ' +
            '"height": 0.5} for the bottom right quarter.',
          properties: {
            page: { type: 'integer', minimum: 1 },
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
            width: { type: 'number', minimum: 0, maximum: 1 },
            height: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['page', 'x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
        include_location: {
          type: 'boolean',
          description:
            "Include a photo's GPS location. Off by default: only ask when the user wants to know where it was taken.",
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    needsApproval: false,
    parse(input) {
      const pages = input.optionalString('pages')
      const start = input.optionalInteger('start', 1, Number.MAX_SAFE_INTEGER)
      const region = parseRegion(input.optionalObject('region'))
      if ([pages, start, region].filter((value) => value !== undefined).length > 1) {
        throw new ToolInputError('use only one of "pages", "start" and "region".')
      }
      const range = pages === undefined ? undefined : parsePages(pages)
      return {
        path: input.string('path'),
        from: range?.from ?? start,
        to: range?.to,
        start,
        region,
        includeLocation: input.optionalBoolean('include_location') === true,
      }
    },
    summarize: (input) => ({
      path: input.path,
      ...(input.from !== undefined && input.start === undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.start !== undefined ? { start: input.start } : {}),
      ...(input.region ? { region: { ...input.region } } : {}),
      ...(input.includeLocation ? { includeLocation: true } : {}),
    }),
    async run(input, call) {
      const { path: file, exists } = await call.resolve(input.path)
      if (!exists) throw new ToolFailure(`File not found: ${file}`, 'not-found')
      if (!(await fs.stat(file)).isFile())
        throw new ToolFailure(`Not a file: ${file}`, 'not-a-file')
      const reader = deps.documents
      if (!reader) {
        throw new ToolFailure('Reading documents is not available in this session.', 'failed')
      }
      // Read through the handle proven to be the guarded file; the worker gets a copy.
      const { handle, stats } = await openVerified(deps.guard, file, 'read')
      let bytes: Buffer
      let size: number
      try {
        size = Number(stats.size)
        if (size > DOCUMENT_LIMITS.maxDocumentBytes) {
          throw new ToolFailure(
            `${file} is ${formatBytes(size)}; documents up to ` +
              `${formatBytes(DOCUMENT_LIMITS.maxDocumentBytes)} can be read.`,
            'too-large',
          )
        }
        bytes = await readBounded(handle, size)
      } finally {
        await handle.close()
      }
      call.throwIfAborted()

      const options: ExtractOptions = { name: path.basename(file) }
      if (input.region) options.select = { region: input.region }
      else if (input.from !== undefined || input.to !== undefined) {
        options.select = {
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
        }
      }
      if (input.includeLocation) options.includeLocation = true

      let view: DocumentView
      try {
        view = await reader.extract(bytes, options)
      } catch (error) {
        if (error instanceof DocumentError) {
          throw new ToolFailure(`Could not read ${file}: ${error.message}`, ERROR_CODES[error.code])
        }
        if (error instanceof ToolFailure) throw error
        throw new ToolFailure(
          `Could not read ${file}: the document reader failed.`,
          'worker-failed',
        )
      }
      call.throwIfAborted()

      const kind = view.meta.kind
      if (kind === 'text') {
        throw new ToolFailure(`${file} is a text file; use read_file to read it.`, 'unsupported')
      }
      if (!READABLE.has(kind)) {
        throw new ToolFailure(
          `${file} is a ${KIND_LABEL[kind]}. ${view.warnings.at(-1) ?? 'Reading it is not supported yet.'}`,
          'unsupported',
        )
      }
      const locationRead = view.sections.some(
        (section) =>
          section.title === 'Image metadata' && /^Location: (?!recorded)/m.test(section.text),
      )
      const images: ToolImage[] = view.images.map((image) => ({
        mime: image.mime,
        data: image.bytes,
        width: image.width,
        height: image.height,
        label: imageLabel(image.source),
      }))
      return {
        content: formatView(file, size, view, input),
        ...(images.length ? { images } : {}),
        audit: {
          kind,
          images: images.length,
          ...(locationRead ? { locationRead: true } : {}),
        },
      }
    },
  }
}

function parsePages(text: string): { from: number; to: number | undefined } {
  const match = /^\s*(\d+)\s*(?:(-)\s*(\d+)?)?\s*$/.exec(text)
  const from = Number(match?.[1])
  const to = match?.[3] === undefined ? (match?.[2] ? undefined : from) : Number(match[3])
  if (!match || from < 1 || from > MAX_PAGE || (to !== undefined && (to < from || to > MAX_PAGE))) {
    throw new ToolInputError('"pages" must be a page or range such as "3", "2-5" or "10-".')
  }
  return { from, to }
}

function parseRegion(raw: Record<string, unknown> | undefined): PageRegion | undefined {
  if (raw === undefined) return undefined
  const keys = ['page', 'x', 'y', 'width', 'height'] as const
  for (const key of Object.keys(raw)) {
    if (!(keys as readonly string[]).includes(key)) {
      throw new ToolInputError(`"region" has an unknown property "${key}".`)
    }
  }
  const [page, x, y, width, height] = keys.map((key) => raw[key])
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    throw new ToolInputError('"region.page" must be a page number.')
  }
  const fractions = [x, y, width, height]
  if (!fractions.every((n): n is number => typeof n === 'number' && n >= 0 && n <= 1)) {
    throw new ToolInputError('"region" x, y, width and height must be numbers from 0 to 1.')
  }
  const [rx, ry, rw, rh] = fractions as [number, number, number, number]
  if (rw <= 0 || rh <= 0 || rx + rw > 1.000001 || ry + rh > 1.000001) {
    throw new ToolInputError('"region" must have a size and lie inside the page.')
  }
  return { page, x: rx, y: ry, width: rw, height: rh }
}

function imageLabel(source: { page?: number; region?: PageRegion }): string {
  if (source.page === undefined) return 'image'
  return source.region
    ? `page ${String(source.page)}, zoomed region`
    : `page ${String(source.page)}`
}

const fraction = (n: number): string => String(Math.round(n * 1000) / 1000)

/** The header line, the text page by page, and where to continue. */
function formatView(file: string, size: number, view: DocumentView, input: Input): string {
  const { meta, position } = view
  const header = [file, KIND_LABEL[meta.kind], formatBytes(size)]
  if (meta.pageCount !== undefined) {
    header.push(`${String(meta.pageCount)} page${meta.pageCount === 1 ? '' : 's'}`)
  }
  if (meta.width !== undefined && meta.height !== undefined) {
    header.push(`${String(meta.width)} x ${String(meta.height)} px`)
  }
  if (input.region) {
    const { page, x, y, width, height } = input.region
    header.push(
      `page ${String(page)} region x=${fraction(x)} y=${fraction(y)} ` +
        `width=${fraction(width)} height=${fraction(height)}`,
    )
  } else if (position.unit === 'page' && position.total > 0) {
    const { from, to } = position.shown
    header.push(
      from === to ? `page ${String(from)} shown` : `pages ${String(from)}-${String(to)} shown`,
    )
  }
  if (meta.title) header.push(`title: ${meta.title}`)
  if (meta.author) header.push(`author: ${meta.author}`)

  const lines = [`[${header.join(' | ')}]`]
  for (const warning of view.warnings) lines.push(`[Note: ${warning}]`)

  const imageIndex = new Map<string, number>()
  view.images.forEach((image, index) => {
    const key = image.source.region ? 'region' : `page ${String(image.source.page ?? '')}`
    imageIndex.set(key, index + 1)
  })
  for (const section of view.sections) {
    if (section.page !== undefined && !input.region) {
      const rendered = imageIndex.get(`page ${String(section.page)}`)
      const note = rendered
        ? section.text.trim()
          ? ` (also attached as image ${String(rendered)})`
          : ` (little or no text; attached as image ${String(rendered)})`
        : ''
      lines.push(`--- Page ${String(section.page)}${note} ---`)
    } else if (section.title) {
      lines.push(`--- ${section.title} ---`)
    }
    if (section.text.trim()) lines.push(section.text.trimEnd())
  }

  if (input.region) {
    const image = view.images[0]
    if (image) {
      lines.push(
        `[Image 1: page ${String(input.region.page)}, the region above, at ` +
          `${String(image.width)} x ${String(image.height)} px]`,
      )
    }
    if (!view.sections.some((section) => section.text.trim()))
      lines.push('[No text in this region.]')
  } else if (meta.kind !== 'pdf') {
    const image = view.images[0]
    lines.push(
      image
        ? `[Image 1: the picture, upright, at ${String(image.width)} x ${String(image.height)} px, with its metadata removed]`
        : '[The picture itself is not attached.]',
    )
  } else if (position.total === 0) {
    lines.push('[The PDF has no pages.]')
  } else if (position.next !== null) {
    lines.push(
      `[More: pages ${String(position.next)}-${String(position.total)} not shown. ` +
        `Call read_document with start: ${String(position.next)} to continue.]`,
    )
  } else {
    lines.push('[End of document.]')
  }
  return lines.join('\n')
}
