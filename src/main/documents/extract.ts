import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import { describeExif, readExif } from './exif'
import { readHeif } from './heif'
import {
  checkDocumentSize,
  checkPixels,
  DEFAULT_LIMITS,
  effectiveBudget,
  imageDimensions,
  type DocumentLimits,
} from './limits'
import { extractDocx } from './docx'
import { extractOdf } from './odf'
import { extractOle } from './ole'
import { OfficePackage } from './package'
import { extractPdf, type EncodeRaster } from './pdf'
import { extractPptx } from './pptx'
import { extractCsv, extractPackageWorkbook } from './sheets'
import { KIND_LABEL, MIME, sniff } from './sniff'
import {
  DocumentError,
  type DocumentImage,
  type DocumentKind,
  type DocumentView,
  type ExtractOptions,
} from './types'

/**
 * Decodes an image with its EXIF orientation applied, then `turn` (an EXIF orientation,
 * for pixels a system codec left as stored), scaled to fit `longEdge`, and re-encodes it
 * in at most `maxBytes`.
 */
export type DecodeImage = (
  bytes: Uint8Array,
  kind: DocumentKind,
  longEdge: number,
  maxBytes: number,
  turn?: number,
) => Promise<Omit<DocumentImage, 'source'>>

/** What the dispatcher needs from its host: PDFium, and the browser's image codecs. */
export interface ExtractEnv {
  pdfium: () => Promise<WrappedPdfiumModule>
  encode: EncodeRaster
  decodeImage: DecodeImage
}

/** Decoded by Chromium in the worker (AVIF with its irot/imir and crop applied). */
const DECODABLE = new Set<DocumentKind>(['jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'avif'])
const NOT_YET = new Set<DocumentKind>(['rtf'])
const PACKAGES = new Set<DocumentKind>([
  'docx',
  'xlsx',
  'pptx',
  'ooxml',
  'odt',
  'ods',
  'odp',
  'odf',
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
  } else if (DECODABLE.has(kind) || kind === 'heic') {
    view = await extractImage(bytes, kind, mime, options, env, limits)
  } else if (kind === 'text') {
    view = isCsv(options)
      ? extractCsv(decodeText(bytes), options, limits)
      : extractText(bytes, options, limits)
  } else if (PACKAGES.has(kind)) {
    view = await extractPackage(bytes, kind, options, limits)
  } else if (kind === 'ole') {
    view = extractOle(bytes, options, limits)
  } else if (NOT_YET.has(kind)) {
    view = emptyView(kind, mime)
    view.warnings.push(`Reading a ${KIND_LABEL[kind]} is not supported yet.`)
  } else if (kind === 'zip') {
    // Some writers compress the OpenDocument mimetype entry, which sniff() cannot see into.
    const odf = await compressedOdfKind(bytes, limits)
    if (!odf) {
      throw new DocumentError(
        'unsupported',
        'ZIP archives are not read. Extract the file you need.',
      )
    }
    view = await extractPackage(bytes, odf, options, limits)
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
  if (kind === 'odf' || kind === 'odt' || kind === 'ods' || kind === 'odp')
    return normal.startsWith('application/vnd.oasis.opendocument')
  if (kind === 'ole') return /msword|ms-excel|ms-powerpoint|ms-outlook/.test(normal)
  // Macro-enabled and template variants of the same packages.
  if (kind === 'docx')
    return /^application\/vnd\.(ms-word|openxmlformats-officedocument\.wordprocessingml)/.test(
      normal,
    )
  if (kind === 'xlsx')
    return /^application\/vnd\.(ms-excel|openxmlformats-officedocument\.spreadsheetml)/.test(normal)
  if (kind === 'pptx')
    return /^application\/vnd\.(ms-powerpoint|openxmlformats-officedocument\.presentationml)/.test(
      normal,
    )
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
  // HEIF turns its image with irot/imir; an EXIF orientation tag inside it is ignored.
  const heif = kind === 'heic' || kind === 'avif' ? readHeif(bytes) : null
  if (exif && heif) exif.orientation = heif.orientation
  const orientation = heif?.orientation ?? exif?.orientation ?? 1
  const shown = heif?.cropped ?? dimensions
  const swapped = orientation >= 5
  view.meta.width = swapped ? shown.height : shown.width
  view.meta.height = swapped ? shown.width : shown.height
  if (exif) {
    const text = describeExif(exif, options.includeLocation === true)
    if (text) view.sections.push({ title: 'Image metadata', text })
  }
  const budget = effectiveBudget(options.budget, limits)
  if (options.view === 'text' || budget.maxImages === 0) return view
  if (kind === 'heic') {
    if (!heif) throw new DocumentError('malformed', 'The image header is damaged.')
    // Chromium has no HEVC decoder: the host decodes it with the system's codec, if any.
    view.systemDecode = {
      format: 'heif',
      coded: heif.coded,
      cropped: heif.cropped,
      orientation: heif.orientation,
    }
    return view
  }

  const turn = options.systemDecoded
    ? remainingTurn(options.systemDecoded.orientation, options.systemDecoded.cropped, dimensions)
    : 1
  try {
    const image = await env.decodeImage(bytes, kind, budget.longEdge, limits.maxImageBytes, turn)
    view.images.push({ ...image, source: {} })
  } catch (error) {
    if (error instanceof DocumentError) throw error
    view.warnings.push(`The ${KIND_LABEL[kind]} could not be decoded here.`)
  }
  if (kind === 'gif') view.warnings.push('Only the first frame of an animated GIF is shown.')
  return view
}

/**
 * The orientation still to apply to a system codec's output of a HEIF photo whose
 * irot/imir make `orientation`, given the photo's size before rotation (`cropped`) and
 * the output's. Windows' HEIF codec is reported to apply irot/imir itself, so the output
 * counts as upright unless a quarter turn visibly did not happen: an output with the
 * shape (portrait or landscape) of the unrotated photo is turned here. A turn that keeps
 * the shape (180 degrees, a mirror) cannot be seen, and is taken as done.
 */
export function remainingTurn(
  orientation: number,
  cropped: { width: number; height: number },
  output: { width: number; height: number },
): number {
  if (orientation < 5 || orientation > 8) return 1
  if (cropped.width === cropped.height || output.width === output.height) return 1
  const unturned = cropped.width > cropped.height === output.width > output.height
  return unturned ? orientation : 1
}

/** Word, Excel, PowerPoint and OpenDocument packages, through the guarded ZIP reader. */
async function extractPackage(
  bytes: Uint8Array,
  kind: DocumentKind,
  options: ExtractOptions,
  limits: DocumentLimits,
): Promise<DocumentView> {
  const pkg = OfficePackage.open(bytes, limits)
  switch (kind) {
    case 'docx':
      return extractDocx(pkg, options, limits)
    case 'xlsx':
    case 'ods':
      return extractPackageWorkbook(pkg, kind, options, limits)
    case 'pptx':
      return extractPptx(pkg, options, limits)
    case 'odt':
    case 'odp':
      return extractOdf(pkg, kind, options, limits)
    case 'ooxml':
      if (pkg.has('xl/workbook.bin')) {
        throw new DocumentError(
          'unsupported',
          'Excel binary workbooks (.xlsb) cannot be read. Open it in Excel and save it as .xlsx, then try again.',
        )
      }
      throw new DocumentError(
        'unsupported',
        'This Office file is not a Word document, Excel workbook or PowerPoint presentation.',
      )
    default:
      throw new DocumentError(
        'unsupported',
        'Only OpenDocument text, spreadsheets and presentations can be read; this OpenDocument file is another kind.',
      )
  }
}

/** An OpenDocument text, spreadsheet or presentation whose mimetype entry is compressed. */
async function compressedOdfKind(
  bytes: Uint8Array,
  limits: DocumentLimits,
): Promise<DocumentKind | null> {
  let pkg: OfficePackage
  try {
    pkg = OfficePackage.open(bytes, limits)
  } catch {
    return null
  }
  if (!pkg.has('mimetype') || !pkg.has('content.xml')) return null
  const mime = new TextDecoder().decode((await pkg.read('mimetype')) ?? new Uint8Array()).trim()
  const kind = (['odt', 'ods', 'odp'] as const).find((odf) => MIME[odf] === mime)
  return kind ?? null
}

/** Text with a .csv or .tsv name, or claimed as CSV, is read as a table. */
function isCsv(options: ExtractOptions): boolean {
  return (
    /\.(csv|tsv)$/i.test(options.name ?? '') ||
    /^text\/(csv|tab-separated-values)\b/i.test(options.mime ?? '')
  )
}

function decodeText(bytes: Uint8Array): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8'
  return new TextDecoder(encoding).decode(bytes)
}

function extractText(
  bytes: Uint8Array,
  options: ExtractOptions,
  limits: DocumentLimits,
): DocumentView {
  const text = decodeText(bytes)
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
