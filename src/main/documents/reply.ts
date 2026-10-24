import { z } from 'zod'
import { effectiveBudget, imageDimensions, type DocumentLimits } from './limits'
import {
  DocumentError,
  type DocumentErrorCode,
  type DocumentView,
  type ExtractOptions,
} from './types'

/**
 * Checks a worker's answer to one job against the request and the limits, and rebuilds
 * it from fresh copies. The worker parses hostile files, so nothing it says is trusted:
 * counts, sizes and text lengths are capped, every image must be the PNG or JPEG it
 * claims with the dimensions it claims, and pages must sit inside the range shown.
 * Anything off throws DocumentError('worker-failed'); the caller kills the worker.
 *
 * It runs twice: in the broker (broker.ts), the first process to touch what the worker
 * sent, and again in main on the broker's copy.
 */

export interface ReplyJob {
  id: number
  options: ExtractOptions
  limits: DocumentLimits
}

export type CheckedReply =
  | { type: 'result'; id: number; view: DocumentView }
  | { type: 'error'; id: number; code: DocumentErrorCode; message: string }

/** Codes a worker may report; anything else is reported as worker-failed. */
const WORKER_CODES = new Set<string>([
  'too-large',
  'too-many-pixels',
  'password-protected',
  'malformed',
  'unsupported',
  'out-of-range',
  'zip-bomb',
  'memory',
])
const KINDS = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'ooxml',
  'odf',
  'zip',
  'ole',
  'doc',
  'xls',
  'ppt',
  'odt',
  'ods',
  'odp',
  'csv',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'avif',
  'heic',
  'rtf',
  'text',
  'unknown',
] as const
/** Room for an image's EXIF section on top of the text budget. */
const METADATA_CHARS = 4096
const MAX_WARNINGS = 50
const MAX_WARNING_CHARS = 1000

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const fraction = z.number().min(0).max(1)
const shortText = (max: number) => z.string().max(max)
/** An A1 reference without a sheet: B2, or A1:H200 (Excel's largest sheet is XFD1048576). */
const a1 = z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/)
const SHEET_NAME_CHARS = 200

export function checkReply(raw: unknown, job: ReplyJob): CheckedReply {
  const { limits, options } = job
  const budget = effectiveBudget(options.budget, limits)
  const maxSections = limits.maxPagesPerCall + 1
  const maxImages = limits.maxImagesPerCall

  const image = z.strictObject({
    bytes: z.instanceof(Uint8Array).refine((b) => b.length > 0 && b.length <= limits.maxImageBytes),
    mime: z.enum(['image/png', 'image/jpeg']),
    width: z.number().int().min(1).max(budget.longEdge),
    height: z.number().int().min(1).max(budget.longEdge),
    source: z.strictObject({
      page: count.min(1).optional(),
      region: z
        .strictObject({
          page: count.min(1),
          x: fraction,
          y: fraction,
          width: fraction,
          height: fraction,
        })
        .optional(),
    }),
  })
  const view = z.strictObject({
    meta: z.strictObject({
      kind: z.enum(KINDS),
      mime: shortText(200),
      name: shortText(1000).optional(),
      pageCount: count.optional(),
      width: count.optional(),
      height: count.optional(),
      title: shortText(1000).optional(),
      author: shortText(1000).optional(),
      sheets: z
        .array(
          z.strictObject({
            name: shortText(SHEET_NAME_CHARS),
            used: a1.nullable(),
            hidden: z.literal(true).optional(),
          }),
        )
        .max(limits.office.maxSheets)
        .optional(),
    }),
    sections: z
      .array(
        z.strictObject({
          page: count.min(1).optional(),
          title: shortText(200).optional(),
          text: z.string().max(budget.maxChars + METADATA_CHARS),
          sheet: z
            .strictObject({
              name: shortText(SHEET_NAME_CHARS),
              shown: a1.nullable(),
              used: a1.nullable(),
              next: a1.optional(),
            })
            .optional(),
        }),
      )
      .max(maxSections),
    images: z.array(image).max(maxImages),
    position: z.strictObject({
      unit: z.enum(['page', 'slide', 'char', 'sheet', 'image']),
      total: count,
      shown: z.strictObject({ from: count, to: count }),
      next: count.min(1).nullable(),
    }),
    warnings: z.array(shortText(MAX_WARNING_CHARS)).max(MAX_WARNINGS),
  })
  const reply = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('result'), id: z.literal(job.id), view }),
    z.strictObject({
      type: z.literal('error'),
      id: z.literal(job.id),
      code: shortText(40),
      message: shortText(1000),
    }),
  ])

  const parsed = reply.safeParse(raw)
  if (!parsed.success) throw invalid('its reply did not match what was asked')
  const data = parsed.data
  if (data.type === 'error') {
    const code = WORKER_CODES.has(data.code) ? (data.code as DocumentErrorCode) : 'worker-failed'
    return {
      type: 'error',
      id: data.id,
      code,
      message: data.message || 'The document could not be read.',
    }
  }
  // zod's optional fields allow an explicit undefined; copyView drops those.
  const checked = data.view as DocumentView
  checkView(checked, budget, limits)
  return { type: 'result', id: data.id, view: copyView(checked) }
}

function checkView(
  view: DocumentView,
  budget: { maxChars: number; maxImages: number; longEdge: number },
  limits: DocumentLimits,
): void {
  const { position } = view
  let chars = 0
  for (const section of view.sections) chars += section.text.length
  if (chars > budget.maxChars + METADATA_CHARS) throw invalid('it returned more text than asked')
  if (view.images.length > budget.maxImages) throw invalid('it returned more images than asked')
  if (position.shown.from > position.shown.to || position.shown.to > position.total) {
    throw invalid('its position is inconsistent')
  }
  if (
    position.next !== null &&
    (position.next <= position.shown.to || position.next > position.total)
  ) {
    throw invalid('its position is inconsistent')
  }
  const shown = position.shown.to - position.shown.from + (position.shown.to ? 1 : 0)
  if (position.unit === 'sheet') {
    if (shown > limits.maxPagesPerCall) throw invalid('it returned more sheets than allowed')
    if (view.meta.sheets?.length !== position.total) throw invalid('its sheet list is inconsistent')
    if (view.sections.length > shown || !view.sections.every((section) => section.sheet)) {
      throw invalid('it returned a sheet it did not show')
    }
  } else if (view.meta.sheets !== undefined || view.sections.some((section) => section.sheet)) {
    throw invalid('it returned sheets for a document that has none')
  }
  if (position.unit === 'page' || position.unit === 'slide') {
    if (shown > limits.maxPagesPerCall) throw invalid('it returned more pages than allowed')
    if (view.meta.pageCount !== undefined && view.meta.pageCount !== position.total) {
      throw invalid('its page count is inconsistent')
    }
    const inRange = (page: number | undefined): boolean =>
      page !== undefined && page >= position.shown.from && page <= position.shown.to
    if (!view.sections.every((section) => inRange(section.page))) {
      throw invalid('it returned a page it did not show')
    }
    if (!view.images.every((image) => inRange(image.source.page))) {
      throw invalid('it returned a page it did not show')
    }
  }
  for (const image of view.images) {
    if (image.width * image.height > limits.maxDecodedPixels) throw invalid('an image is too large')
    if (image.source.region && image.source.region.page !== image.source.page) {
      throw invalid('an image region is inconsistent')
    }
    const kind = image.mime === 'image/png' ? 'png' : 'jpeg'
    // Null unless the bytes start with a full PNG signature and IHDR, or a JPEG SOI and frame.
    const header = imageDimensions(image.bytes, kind)
    if (header?.width !== image.width || header.height !== image.height) {
      throw invalid('an image is not what it claims to be')
    }
  }
}

/** A deep copy holding only plain values and fresh byte arrays. */
function copyView(view: DocumentView): DocumentView {
  return {
    meta: {
      ...defined(view.meta),
      ...(view.meta.sheets ? { sheets: view.meta.sheets.map(defined) } : {}),
    },
    sections: view.sections.map((section) => ({
      ...defined(section),
      ...(section.sheet ? { sheet: defined(section.sheet) } : {}),
    })),
    images: view.images.map((image) => ({
      bytes: new Uint8Array(image.bytes),
      mime: image.mime,
      width: image.width,
      height: image.height,
      source: {
        ...(image.source.page === undefined ? {} : { page: image.source.page }),
        ...(image.source.region ? { region: { ...image.source.region } } : {}),
      },
    })),
    position: {
      unit: view.position.unit,
      total: view.position.total,
      shown: { ...view.position.shown },
      next: view.position.next,
    },
    warnings: [...view.warnings],
  }
}

/** A shallow copy without keys whose value is undefined. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

const invalid = (why: string): DocumentError =>
  new DocumentError('worker-failed', `The document reader returned an invalid result: ${why}.`)
