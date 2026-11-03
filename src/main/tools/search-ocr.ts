// search_files' OCR of scanned PDF pages: the sandboxed reader renders one page per job as raw
// grey pixels (main never parses the PDF), and Windows' OCR reads them in ocr-text.exe, which
// is verified before every run. The search decides which documents get this and when; here is
// what happens to one document's pages. See docs/document-reader.md#ocr-of-scanned-pages.
import {
  OCR_DEFAULT_TIMEOUT_MS,
  OcrError,
  type OcrImage,
  type OcrUnavailableReason,
  type SystemOcr,
} from '../documents/system-ocr'
import {
  DocumentError,
  type DocumentErrorCode,
  type DocumentReader,
  type PageRaster,
} from '../documents/types'
import type { CachedText, OcrPage } from './document-text-cache'
import { BUSY_RETRY_MS, LASTING, pause, within } from './search-documents'

export type OcrOff = OcrUnavailableReason | 'failed'

/** Failures in a row, without a page read between them, after which a call stops trying. */
const MAX_FAILURES_IN_A_ROW = 3
/** A document's progress is saved this often, and whenever its OCR stops. */
const SAVE_EVERY_MS = 5000

/**
 * A page counts as read well with this many letters and digits in words of at least three, and
 * with those making up at least half of what came back. Sideways text reads as next to
 * nothing, or as scattered single characters; Windows' OCR reports no confidence of its own.
 */
const GOOD_READING_CHARS = 40
/** A word in a script Windows' OCR splits by the character reads as such one character at a time. */
const WHOLE_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
/** The turns tried on a page that did not read well, in order, stopping at the first that does. */
const TURNS = [90, 270, 180] as const
/** Pixels differing from the page's commonest grey by more than this are ink. */
const INK_CONTRAST = 32
/** A share of ink under this is a blank page, scanner noise included: not worth a helper run. */
const BLANK_INK = 0.00005

/** How much of what OCR returned looks like words. */
export function readingScore(lines: readonly string[]): { words: number; all: number } {
  let words = 0
  let all = 0
  for (const line of lines) {
    for (const token of line.split(/\s+/u)) {
      if (!token) continue
      all += token.length
      const chars = token.match(/[\p{L}\p{N}]/gu)?.length ?? 0
      if (chars >= 3 || (chars > 0 && WHOLE_CHARS.test(token))) words += chars
    }
  }
  return { words, all }
}

const readsWell = ({ words, all }: { words: number; all: number }): boolean =>
  words >= GOOD_READING_CHARS && words * 2 >= all

/** A grey image turned clockwise by 90, 180 or 270 degrees: pixels only, no parsing. */
export function turnGray(image: OcrImage, degrees: 90 | 180 | 270): OcrImage {
  const { width, height, pixels } = image
  const out = new Uint8Array(pixels.length)
  if (degrees === 180) {
    for (let i = 0; i < pixels.length; i++) out[pixels.length - 1 - i] = pixels[i] ?? 0
    return { ...image, pixels: out }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      // Turned width is `height`: 90 sends (x, y) to (height-1-y, x), 270 to (y, width-1-x).
      const at = degrees === 90 ? x * height + (height - 1 - y) : (width - 1 - x) * height + y
      out[at] = pixels[row + x] ?? 0
    }
  }
  return { width: height, height: width, format: image.format, pixels: out }
}

/** The share of a grey image's pixels that differ clearly from its commonest grey. */
export function inkShare(pixels: Uint8Array): number {
  if (pixels.length === 0) return 0
  const counts = new Uint32Array(256)
  for (const value of pixels) counts[value] = (counts[value] ?? 0) + 1
  let paper = 0
  for (let grey = 1; grey < 256; grey++) {
    if ((counts[grey] ?? 0) > (counts[paper] ?? 0)) paper = grey
  }
  let ink = 0
  for (let grey = 0; grey < 256; grey++) {
    if (Math.abs(grey - paper) > INK_CONTRAST) ink += counts[grey] ?? 0
  }
  return ink / pixels.length
}

/** One search call's OCR so far, across its documents. */
export interface OcrRun {
  /** Why this call stopped trying, for all that is left. */
  off: OcrOff | null
  /** What to tell the agent about `off`, when there is more to say than its label. */
  offMessage: string | null
  failuresInARow: number
  /** Pages finished by this call, blank ones included. */
  pagesRead: number
  /** Times the helper ran: more than pagesRead when pages were turned and read again. */
  helperRuns: number
}

export const newOcrRun = (): OcrRun => ({
  off: null,
  offMessage: null,
  failuresInARow: 0,
  pagesRead: 0,
  helperRuns: 0,
})

export interface OcrDocumentJob {
  reader: DocumentReader
  ocr: SystemOcr
  bytes: Uint8Array
  name: string
  /** Its `ocr` pages are updated in place. */
  text: CachedText
  /** Characters a document may hold, its text layer included. */
  maxChars: number
  timeLeft: () => number
  now: () => number
  signal: AbortSignal
  /** Whether the file's folder is still granted as it was when its bytes were read. */
  stillGranted: () => boolean
  /** Saves the text in the cache; false when it was not kept. */
  keep: (text: CachedText) => Promise<boolean>
  run: OcrRun
}

export interface OcrDocumentResult {
  /**
   * 'finished': no page is waiting. 'time': out of time, 'cancelled': stopped; pending pages
   * are for later. 'gone': the folder's grant went, and nothing more was kept. 'off': the call
   * stopped trying (`run.off` says why).
   */
  outcome: 'finished' | 'time' | 'cancelled' | 'gone' | 'off'
  /** Pages that failed in a way worth trying again: reported as failed, kept as pending. */
  failedNow: Set<number>
  /** Whether the last save worked: if not, the pages read since do not outlive this call. */
  kept: boolean
}

type PageOutcome =
  | { kind: 'read'; text: string; low: boolean }
  | { kind: 'failed'; code: string; lasting: boolean }
  | { kind: 'stop'; why: 'time' | 'cancelled' }
  | { kind: 'off'; reason: OcrUnavailableReason; message: string }

/** The page's pixels from the reader: one bounded background job, asked again while it is busy. */
async function renderForOcr(
  job: OcrDocumentJob,
  page: OcrPage,
): Promise<PageRaster | Exclude<PageOutcome, { kind: 'read' }>> {
  for (;;) {
    try {
      const view = await within(
        job.reader,
        job.bytes,
        {
          name: job.name,
          view: 'raster',
          select: { from: page.page, to: page.page },
          budget: { maxImages: 0, maxChars: 1, longEdge: page.longEdge },
        },
        job.timeLeft,
        job.signal,
      )
      if (view === 'time' || view === 'cancelled') return { kind: 'stop', why: view }
      const raster = view.rasters?.[0]
      if (raster) return raster
      return { kind: 'failed', code: 'worker-failed', lasting: false }
    } catch (error) {
      const code: DocumentErrorCode = error instanceof DocumentError ? error.code : 'worker-failed'
      if (code !== 'busy' && code !== 'cancelled') {
        return { kind: 'failed', code, lasting: LASTING.has(code) }
      }
      await pause(Math.min(BUSY_RETRY_MS, job.timeLeft()), job.signal)
      if (job.signal.aborted) return { kind: 'stop', why: 'cancelled' }
      if (job.timeLeft() <= 0) return { kind: 'stop', why: 'time' }
    }
  }
}

/** A failure to read the image as what the page's OCR ends with. */
function ocrFailure(error: unknown, job: OcrDocumentJob): Exclude<PageOutcome, { kind: 'read' }> {
  if (!(error instanceof OcrError)) {
    return { kind: 'failed', code: 'failed', lasting: false }
  }
  switch (error.code) {
    case 'cancelled':
      return { kind: 'stop', why: 'cancelled' }
    case 'timeout':
      // The search's own deadline is no fault of the page; the helper's 60 s limit is.
      return job.timeLeft() <= 0
        ? { kind: 'stop', why: 'time' }
        : { kind: 'failed', code: 'timeout', lasting: true }
    case 'unsupported':
    case 'unavailable':
    case 'no-language':
      return { kind: 'off', reason: error.code, message: error.message }
    case 'memory':
    case 'too-large':
    case 'invalid-image':
    case 'output':
      return { kind: 'failed', code: error.code, lasting: true }
    case 'failed':
      return { kind: 'failed', code: 'failed', lasting: false }
  }
}

/**
 * Reads an image as it is, and, if that gave little that looks like words, turned 90, 270 and
 * then 180 degrees, keeping the best: the bounded answer to sideways scans. Costs up to three
 * more helper runs on such a page, none on a page that reads well the first time.
 */
async function readImage(job: OcrDocumentJob, image: OcrImage): Promise<PageOutcome> {
  const recognize = async (turned: OcrImage) => {
    const timeoutMs = Math.min(OCR_DEFAULT_TIMEOUT_MS, job.timeLeft())
    if (timeoutMs <= 0) throw new OcrError('timeout', 'No time left.')
    job.run.helperRuns++
    const result = await job.ocr.recognize(turned, { signal: job.signal, timeoutMs })
    const lines = result.lines.map((line) => line.text)
    return { lines, score: readingScore(lines), truncated: result.truncated }
  }
  let best
  try {
    best = await recognize(image)
  } catch (error) {
    return ocrFailure(error, job)
  }
  if (!readsWell(best.score)) {
    for (const degrees of TURNS) {
      // 90 and 270 are always both read: one of them is upside down, which reads as plausible
      // letters, so the one that reads well first is not yet the right one.
      if (degrees === 180 && readsWell(best.score)) break
      try {
        const turned = await recognize(turnGray(image, degrees))
        if (turned.score.words > best.score.words) best = turned
      } catch (error) {
        const failure = ocrFailure(error, job)
        if (failure.kind !== 'failed') return failure
        // The page has its reading; a turned copy that fails adds nothing to it.
        break
      }
    }
  }
  return {
    kind: 'read',
    text: best.lines.join('\n'),
    low: !readsWell(best.score) || best.truncated,
  }
}

async function readPage(job: OcrDocumentJob, page: OcrPage): Promise<PageOutcome> {
  const raster = await renderForOcr(job, page)
  if ('kind' in raster) return raster
  if (inkShare(raster.pixels) < BLANK_INK) return { kind: 'read', text: '', low: false }
  return readImage(job, {
    width: raster.width,
    height: raster.height,
    format: 'gray8',
    pixels: raster.pixels,
  })
}

const charsOf = (text: CachedText): number =>
  text.segments.reduce((sum, segment) => sum + segment.text.length, 0) +
  text.ocr.reduce((sum, page) => sum + page.text.length, 0)

/**
 * Reads a document's pending pages in order until none is left, the time runs out or the search
 * stops. What was read is saved every few seconds and whenever it stops, so a page is read once
 * and a later call picks up the rest. Between pages nothing is held in the reader, so a
 * read_document waits for one page's job at most.
 */
export async function ocrDocument(job: OcrDocumentJob): Promise<OcrDocumentResult> {
  const { text, run } = job
  const failedNow = new Set<number>()
  let kept = true
  let dirty = false
  let saved = job.now()
  const save = async (): Promise<void> => {
    if (!dirty) return
    dirty = false
    kept = await job.keep(text)
    saved = job.now()
  }
  const end = async (outcome: OcrDocumentResult['outcome']): Promise<OcrDocumentResult> => {
    await save()
    return { outcome, failedNow, kept }
  }
  let chars = charsOf(text)
  for (const page of text.ocr) {
    if (page.state !== 'pending') continue
    if (job.signal.aborted) return end('cancelled')
    if (!job.stillGranted()) return { outcome: 'gone', failedNow, kept: false }
    if (job.timeLeft() <= 0) return end('time')
    if (chars >= job.maxChars) {
      page.state = 'failed'
      page.failure = 'too-long'
      dirty = true
      continue
    }
    const outcome = await readPage(job, page)
    // A read that ended after the grant went is not kept (put refuses it too), nor reported.
    if (!job.stillGranted()) return { outcome: 'gone', failedNow, kept: false }
    switch (outcome.kind) {
      case 'stop':
        return end(outcome.why)
      case 'off':
        run.off = outcome.reason
        run.offMessage = outcome.message
        return end('off')
      case 'failed':
        if (outcome.lasting) {
          page.state = 'failed'
          page.failure = outcome.code
          dirty = true
        } else {
          failedNow.add(page.page)
        }
        // One such failure is a page; three in a row, and OCR itself is what is wrong, however
        // many pages are left. A page that fails for good only costs its own time, once.
        if (!outcome.lasting && ++run.failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          run.off = 'failed'
          return end('off')
        }
        break
      case 'read': {
        page.state = 'done'
        page.text = outcome.text.slice(0, job.maxChars - chars)
        page.low = outcome.low
        chars += page.text.length
        dirty = true
        run.failuresInARow = 0
        run.pagesRead++
        break
      }
    }
    if (job.now() - saved >= SAVE_EVERY_MS) await save()
  }
  return end('finished')
}
