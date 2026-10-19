import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import { DEFAULT_LIMITS, type DocumentLimits } from './limits'
import {
  DocumentError,
  type DocumentImage,
  type DocumentSection,
  type DocumentView,
  type ExtractOptions,
  type PageRegion,
} from './types'

/** Encodes an RGBA raster (row-major, no padding) as PNG or JPEG. */
export type EncodeRaster = (
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
) => Promise<{ bytes: Uint8Array; mime: DocumentImage['mime'] }>

// fpdfview.h
const FPDF_ERR_PASSWORD = 4
const FPDF_ERR_SECURITY = 5
const FPDFBitmap_BGRA = 4
const FPDF_ANNOT = 0x01
const FPDF_REVERSE_BYTE_ORDER = 0x10
/** A page with fewer non-space characters than this is treated as a scan or drawing. */
const SPARSE_TEXT = 32
const DEFAULT_MAX_IMAGES = 8

/**
 * Reads a PDF with PDFium: text per page, page count and metadata, and rendered pages
 * (or one region of a page) as images. `pdfium` must already be initialised
 * (PDFiumExt_Init). Runs inside the sandboxed worker; the unit tests run it in Node.
 */
export async function extractPdf(
  pdfium: WrappedPdfiumModule,
  bytes: Uint8Array,
  options: ExtractOptions,
  encode: EncodeRaster,
  limits: DocumentLimits = DEFAULT_LIMITS,
): Promise<DocumentView> {
  const { wasmExports } = pdfium.pdfium
  const data = wasmExports.malloc(bytes.length)
  if (!data) throw new DocumentError('memory', 'Not enough memory to open the PDF.')
  heap(pdfium).set(bytes, data)
  try {
    const doc = pdfium.FPDF_LoadMemDocument(data, bytes.length, '')
    if (!doc) {
      const error = pdfium.FPDF_GetLastError()
      if (error === FPDF_ERR_PASSWORD) {
        throw new DocumentError(
          'password-protected',
          'The PDF is password-protected. Save a copy without the password and try again.',
        )
      }
      if (error === FPDF_ERR_SECURITY) {
        throw new DocumentError('unsupported', 'The PDF uses an unsupported security handler.')
      }
      throw new DocumentError('malformed', 'The PDF is damaged or not a PDF.')
    }
    try {
      return await readDocument(pdfium, doc, options, encode, limits)
    } finally {
      pdfium.FPDF_CloseDocument(doc)
    }
  } finally {
    wasmExports.free(data)
  }
}

async function readDocument(
  pdfium: WrappedPdfiumModule,
  doc: number,
  options: ExtractOptions,
  encode: EncodeRaster,
  limits: DocumentLimits,
): Promise<DocumentView> {
  const total = pdfium.FPDF_GetPageCount(doc)
  const view: DocumentView = {
    meta: { kind: 'pdf', mime: 'application/pdf', pageCount: total },
    sections: [],
    images: [],
    position: { unit: 'page', total, shown: { from: 0, to: 0 }, next: null },
    warnings: [],
  }
  const title = metaText(pdfium, doc, 'Title')
  if (title) view.meta.title = title
  const author = metaText(pdfium, doc, 'Author')
  if (author) view.meta.author = author
  if (total === 0) {
    view.warnings.push('The PDF has no pages.')
    return view
  }
  const longEdge = Math.min(options.budget?.longEdge ?? limits.defaultLongEdge, limits.maxLongEdge)
  const maxImages = Math.min(
    options.budget?.maxImages ?? DEFAULT_MAX_IMAGES,
    limits.maxImagesPerCall,
  )

  const region = options.select?.region
  if (region) {
    checkRegion(region, total)
    await withPage(pdfium, doc, region.page, async (page) => {
      const text = boundedText(pdfium, page, region)
      if (text) view.sections.push({ page: region.page, text })
      view.images.push(
        await renderPage(pdfium, page, region.page, longEdge, limits, encode, region),
      )
    })
    view.position.shown = { from: region.page, to: region.page }
    return view
  }

  const from = Math.max(1, Math.floor(options.select?.from ?? 1))
  if (from > total) {
    throw new DocumentError(
      'out-of-range',
      `Page ${String(from)} is past the end; the PDF has ${String(total)} pages.`,
    )
  }
  const mode = options.view ?? 'auto'
  // Every page shown is rendered in 'images' mode, so the image budget is the page budget.
  const pageBudget = mode === 'images' ? Math.max(1, maxImages) : limits.maxPagesPerCall
  const to = Math.min(
    total,
    Math.max(from, Math.floor(options.select?.to ?? total)),
    from + pageBudget - 1,
  )
  const maxChars = Math.max(1, options.budget?.maxChars ?? limits.defaultMaxChars)
  let chars = 0
  let last = from - 1
  let skippedRenders = 0
  for (let number = from; number <= to; number++) {
    const stop = await withPage(pdfium, doc, number, async (page) => {
      let text = pageText(pdfium, page)
      if (chars + text.length > maxChars) {
        if (number > from) return true
        text = text.slice(0, maxChars)
        view.warnings.push(`Page ${String(number)} was cut to ${String(maxChars)} characters.`)
      }
      chars += text.length
      const section: DocumentSection = { page: number, text }
      view.sections.push(section)
      const sparse = text.replace(/\s/g, '').length < SPARSE_TEXT
      if (mode === 'images' || (mode === 'auto' && sparse)) {
        if (view.images.length < maxImages) {
          view.images.push(await renderPage(pdfium, page, number, longEdge, limits, encode))
        } else {
          skippedRenders++
        }
      }
      return false
    })
    if (stop) break
    last = number
  }
  view.position.shown = { from, to: last }
  view.position.next = last < total ? last + 1 : null
  if (skippedRenders) {
    view.warnings.push(
      `${String(skippedRenders)} more page(s) with little or no text were not rendered ` +
        `(image budget ${String(maxImages)}).`,
    )
  }
  return view
}

/** The WASM heap. Read it after each call: it is replaced when memory grows. */
const heap = (pdfium: WrappedPdfiumModule): Uint8Array =>
  (pdfium.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8

async function withPage<T>(
  pdfium: WrappedPdfiumModule,
  doc: number,
  number: number,
  read: (page: number) => Promise<T>,
): Promise<T> {
  const page = pdfium.FPDF_LoadPage(doc, number - 1)
  if (!page) throw new DocumentError('malformed', `Page ${String(number)} could not be read.`)
  try {
    return await read(page)
  } finally {
    pdfium.FPDF_ClosePage(page)
  }
}

function checkRegion(region: PageRegion, total: number): void {
  const { page, x, y, width, height } = region
  if (!Number.isInteger(page) || page < 1 || page > total) {
    throw new DocumentError(
      'out-of-range',
      `Page ${String(page)} does not exist; the PDF has ${String(total)} pages.`,
    )
  }
  const fractions = [x, y, width, height]
  if (
    !fractions.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
    width <= 0 ||
    height <= 0 ||
    x + width > 1.000001 ||
    y + height > 1.000001
  ) {
    throw new DocumentError(
      'out-of-range',
      'A region is x, y, width and height as fractions (0 to 1) of the page, inside the page.',
    )
  }
}

function withText<T>(pdfium: WrappedPdfiumModule, page: number, read: (text: number) => T): T {
  const text = pdfium.FPDFText_LoadPage(page)
  if (!text) throw new DocumentError('malformed', 'The page text could not be read.')
  try {
    return read(text)
  } finally {
    pdfium.FPDFText_ClosePage(text)
  }
}

function utf16(pdfium: WrappedPdfiumModule, chars: number, fill: (buffer: number) => void): string {
  const buffer = pdfium.pdfium.wasmExports.malloc((chars + 1) * 2)
  if (!buffer) throw new DocumentError('memory', 'Not enough memory to read the PDF text.')
  try {
    fill(buffer)
    return (pdfium.pdfium as unknown as { UTF16ToString: (at: number) => string }).UTF16ToString(
      buffer,
    )
  } finally {
    pdfium.pdfium.wasmExports.free(buffer)
  }
}

const tidy = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/￾|\0/g, '')

function pageText(pdfium: WrappedPdfiumModule, page: number): string {
  return withText(pdfium, page, (text) => {
    const count = pdfium.FPDFText_CountChars(text)
    if (count <= 0) return ''
    return tidy(utf16(pdfium, count, (buffer) => pdfium.FPDFText_GetText(text, 0, count, buffer)))
  })
}

/** The text inside a region; PDF space has its origin bottom left. */
function boundedText(pdfium: WrappedPdfiumModule, page: number, region: PageRegion): string {
  const width = pdfium.FPDF_GetPageWidthF(page)
  const height = pdfium.FPDF_GetPageHeightF(page)
  const left = region.x * width
  const right = (region.x + region.width) * width
  const top = height - region.y * height
  const bottom = height - (region.y + region.height) * height
  return withText(pdfium, page, (text) => {
    const count = pdfium.FPDFText_GetBoundedText(text, left, top, right, bottom, 0, 0)
    if (count <= 0) return ''
    return tidy(
      utf16(pdfium, count, (buffer) =>
        pdfium.FPDFText_GetBoundedText(text, left, top, right, bottom, buffer, count),
      ),
    ).trim()
  })
}

function metaText(pdfium: WrappedPdfiumModule, doc: number, tag: string): string | undefined {
  const length = pdfium.FPDF_GetMetaText(doc, tag, 0, 0)
  if (length <= 2 || length > 64 * 1024) return undefined
  const value = utf16(pdfium, length / 2, (buffer) =>
    pdfium.FPDF_GetMetaText(doc, tag, buffer, length),
  ).trim()
  return value ? value.slice(0, 500) : undefined
}

/**
 * Renders a page, or one region of it, so the long edge is `longEdge` pixels. A region
 * is drawn by offsetting a page-sized render into a region-sized bitmap: PDFium only
 * rasterises what lands inside it, so zooming in costs no more than the output.
 */
async function renderPage(
  pdfium: WrappedPdfiumModule,
  page: number,
  pageNumber: number,
  longEdge: number,
  limits: DocumentLimits,
  encode: EncodeRaster,
  region?: PageRegion,
): Promise<DocumentImage> {
  const pageWidth = pdfium.FPDF_GetPageWidthF(page)
  const pageHeight = pdfium.FPDF_GetPageHeightF(page)
  if (!(pageWidth > 0 && pageHeight > 0)) {
    throw new DocumentError('malformed', 'The page has no size.')
  }
  const areaWidth = pageWidth * (region?.width ?? 1)
  const areaHeight = pageHeight * (region?.height ?? 1)
  let scale = longEdge / Math.max(areaWidth, areaHeight)
  if (region) scale = Math.min(scale, limits.maxRegionScale)
  // Pages can be huge (a 200-inch banner); keep the bitmap under the pixel cap.
  const pixels = areaWidth * scale * (areaHeight * scale)
  if (pixels > limits.maxDecodedPixels) scale *= Math.sqrt(limits.maxDecodedPixels / pixels)
  const width = Math.max(1, Math.round(areaWidth * scale))
  const height = Math.max(1, Math.round(areaHeight * scale))

  const bitmap = pdfium.FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, 0, 0)
  if (!bitmap) throw new DocumentError('memory', 'Not enough memory to render the page.')
  let rgba: Uint8ClampedArray<ArrayBuffer>
  try {
    pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
    pdfium.FPDF_RenderPageBitmap(
      bitmap,
      page,
      -Math.round((region?.x ?? 0) * pageWidth * scale),
      -Math.round((region?.y ?? 0) * pageHeight * scale),
      Math.round(pageWidth * scale),
      Math.round(pageHeight * scale),
      0,
      FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER,
    )
    const stride = pdfium.FPDFBitmap_GetStride(bitmap)
    const start = pdfium.FPDFBitmap_GetBuffer(bitmap)
    const memory = heap(pdfium)
    rgba = new Uint8ClampedArray(width * height * 4)
    for (let row = 0; row < height; row++) {
      const at = start + row * stride
      rgba.set(memory.subarray(at, at + width * 4), row * width * 4)
    }
  } finally {
    pdfium.FPDFBitmap_Destroy(bitmap)
  }
  const encoded = await encode(rgba, width, height)
  const source: DocumentImage['source'] = region
    ? { page: pageNumber, region }
    : { page: pageNumber }
  return { ...encoded, width, height, source }
}
