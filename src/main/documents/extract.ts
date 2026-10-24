import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import { describeExif, readExif } from './exif'
import {
  checkDocumentSize,
  checkPixels,
  DEFAULT_LIMITS,
  effectiveBudget,
  imageDimensions,
  type DocumentLimits,
} from './limits'
import { extractPdf, type EncodeRaster } from './pdf'
import { KIND_LABEL, sniff } from './sniff'
import {
  DocumentError,
  type DocumentImage,
  type DocumentKind,
  type DocumentView,
  type ExtractOptions,
} from './types'

/**
 * Decodes an image with its EXIF orientation applied, scaled to fit `longEdge`, and
 * re-encodes it in at most `maxBytes`.
 */
export type DecodeImage = (
  bytes: Uint8Array,
  kind: DocumentKind,
  longEdge: number,
  maxBytes: number,
) => Promise<Omit<DocumentImage, 'source'>>

/** What the dispatcher needs from its host: PDFium, and the browser's image codecs. */
export interface ExtractEnv {
  pdfium: () => Promise<WrappedPdfiumModule>
  encode: EncodeRaster
  decodeImage: DecodeImage
}

const DECODABLE = new Set<DocumentKind>(['jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'])
const NOT_YET = new Set<DocumentKind>([
  'docx',
  'xlsx',
  'pptx',
  'ooxml',
  'odf',
  'ole',
  'rtf',
  'heic',
  'avif',
])

/** Reads any supported document into a {@link DocumentView}. Runs inside the sandboxed worker. */
export async function extractDocument(
  bytes: Uint8Array,
  options: ExtractOptions,
  env: ExtractEnv,
  limits: DocumentLimits = DEFAULT_LIMITS,
): Promise<DocumentView> {
  checkDocumentSize(bytes.length, limits)
  if (bytes.length === 0) throw new DocumentError('malformed', 'The file is empty.')
  const { kind, mime } = sniff(bytes)
  const warnings: string[] = []
  if (options.mime && !sameType(options.mime, mime, kind)) {
    warnings.push(`The file says it is ${options.mime} but its contents are a ${KIND_LABEL[kind]}.`)
  }

  let view: DocumentView
  if (kind === 'pdf') {
    view = await extractPdf(await env.pdfium(), bytes, options, env.encode, limits)
  } else if (DECODABLE.has(kind)) {
    view = await extractImage(bytes, kind, mime, options, env, limits)
  } else if (kind === 'text') {
    view = extractText(bytes, options, limits)
  } else if (NOT_YET.has(kind)) {
    view = emptyView(kind, mime)
    view.warnings.push(
      kind === 'heic'
        ? 'HEIC/HEIF images are not supported yet. Convert it to JPEG or PNG and try again.'
        : `Reading a ${KIND_LABEL[kind]} is not supported yet.`,
    )
  } else if (kind === 'zip') {
    throw new DocumentError('unsupported', 'ZIP archives are not read. Extract the file you need.')
  } else {
    throw new DocumentError('unsupported', 'This file type is not recognised, so it was not read.')
  }
  if (options.name) view.meta.name = options.name
  view.warnings.unshift(...warnings)
  return view
}

function sameType(claimed: string, actual: string, kind: DocumentKind): boolean {
  const normal = claimed.toLowerCase().split(';')[0]?.trim() ?? ''
  if (normal === actual || normal === 'application/octet-stream') return true
  if (kind === 'jpeg' && normal === 'image/jpg') return true
  if (kind === 'text')
    return normal.startsWith('text/') || normal.endsWith('json') || normal.endsWith('xml')
  if (kind === 'odf') return normal.startsWith('application/vnd.oasis.opendocument')
  if (kind === 'ole') return /msword|ms-excel|ms-powerpoint|ms-outlook/.test(normal)
  if (kind === 'heic') return normal === 'image/heif'
  return false
}

function emptyView(kind: DocumentKind, mime: string): DocumentView {
  return {
    meta: { kind, mime },
    sections: [],
    images: [],
    position: { unit: 'image', total: 0, shown: { from: 0, to: 0 }, next: null },
    warnings: [],
  }
}

async function extractImage(
  bytes: Uint8Array,
  kind: DocumentKind,
  mime: string,
  options: ExtractOptions,
  env: ExtractEnv,
  limits: DocumentLimits,
): Promise<DocumentView> {
  // Check the size the header claims before anything decodes the pixels.
  const dimensions = imageDimensions(bytes, kind)
  if (!dimensions) throw new DocumentError('malformed', 'The image header is damaged.')
  checkPixels(dimensions.width, dimensions.height, limits)

  const view = emptyView(kind, mime)
  view.position = { unit: 'image', total: 1, shown: { from: 1, to: 1 }, next: null }
  const exif = readExif(bytes, kind)
  const swapped = (exif?.orientation ?? 1) >= 5
  view.meta.width = swapped ? dimensions.height : dimensions.width
  view.meta.height = swapped ? dimensions.width : dimensions.height
  if (exif) {
    const text = describeExif(exif, options.includeLocation === true)
    if (text) view.sections.push({ title: 'Image metadata', text })
  }
  const budget = effectiveBudget(options.budget, limits)
  if (options.view === 'text' || budget.maxImages === 0) return view

  try {
    const image = await env.decodeImage(bytes, kind, budget.longEdge, limits.maxImageBytes)
    view.images.push({ ...image, source: {} })
  } catch (error) {
    if (error instanceof DocumentError) throw error
    view.warnings.push(`The ${KIND_LABEL[kind]} could not be decoded here.`)
  }
  if (kind === 'gif') view.warnings.push('Only the first frame of an animated GIF is shown.')
  return view
}

function extractText(
  bytes: Uint8Array,
  options: ExtractOptions,
  limits: DocumentLimits,
): DocumentView {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8'
  const text = new TextDecoder(encoding).decode(bytes)
  const total = text.length
  const from = Math.max(1, Math.floor(options.select?.from ?? 1))
  const { maxChars } = effectiveBudget(options.budget, limits)
  const view = emptyView('text', 'text/plain')
  if (total === 0) {
    view.position = { unit: 'char', total, shown: { from: 0, to: 0 }, next: null }
    return view
  }
  if (from > total) {
    throw new DocumentError(
      'out-of-range',
      `Character ${String(from)} is past the end; the text has ${String(total)} characters.`,
    )
  }
  const to = Math.min(
    total,
    from - 1 + maxChars,
    Math.max(from, Math.floor(options.select?.to ?? total)),
  )
  view.position = { unit: 'char', total, shown: { from, to }, next: to < total ? to + 1 : null }
  view.sections.push({ text: text.slice(from - 1, to) })
  return view
}
