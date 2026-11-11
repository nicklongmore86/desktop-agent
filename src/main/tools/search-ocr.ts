// search_files' OCR of scanned PDF pages: the sandboxed reader renders one page per job as raw
// grey pixels (main never parses the PDF), and Windows' OCR reads them in ocr-text.exe, which
// is verified before every run. The search decides which documents get this and when; here is
// what happens to one document's pages. See docs/document-reader.md#ocr-of-scanned-pages.
import {
  OCR_DEFAULT_TIMEOUT_MS,
  OCR_MAX_EDGE,
  OCR_MAX_OUTPUT_BYTES,
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

export type OcrOff = OcrUnavailableReason | 'failed' | 'on-battery'

/** What the agent is told when OCR waits for mains power. */
export const OCR_ON_BATTERY =
  'Reading scanned pages (OCR) pauses while this PC runs on battery power, to save it. ' +
  'Plug it in and search again to read the pages left; nothing read so far is lost.'

/** Failures in a row, without a page read between them, after which a call stops trying. */
const MAX_FAILURES_IN_A_ROW = 3
/** A document's progress is saved this often, and whenever its OCR stops. */
const SAVE_EVERY_MS = 5000

/**
 * Windows' OCR reports no confidence of its own, so a reading is judged by what it looks like.
 * Measured on its real output: text the right way up is almost all well-formed words ("Invoice
 * number 48213"). Sideways text reads as scattered characters ("o | 0 | -c"). Upside-down text
 * reads as plenty of letters, most of them not well-formed ("90!JJ0 pelW00 peu6!s eseeld"), about
 * 40% by this measure. A page reads well with this many characters in well-formed words...
 */
const GOOD_READING_CHARS = 40
/** ...making up at least this share of its letters and digits. */
const GOOD_READING_SHARE = 0.7
/** A word in a script Windows' OCR splits by the character reads as such one character at a time. */
const WHOLE_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
/** How far a page image is turned clockwise. */
export type Turn = 0 | 90 | 180 | 270
/** Probes are read at this share of the page's size: cheaper, and plenty to tell which way is up. */
export const PROBE_SCALE = 0.6
/** Grey rows between the turned copies in a probe, so no line of text runs from one into the next. */
const PROBE_GUTTER = 24
/** A probe's copy reads well with this many characters in well-formed words (fewer at its size). */
const PROBE_GOOD_CHARS = 24
/** A reported text angle within this many degrees of a quarter turn suggests that turn. */
const ANGLE_SLACK = 15
/** Pages rendered and not yet read, in main at once: the one being read and the next. */
const MAX_IMAGES = 2
/**
 * The most text one page's reading can hold: the helper's output cap, in bytes, which is
 * never fewer than the UTF-16 characters of the lines it holds.
 */
const PAGE_TEXT_MOST = OCR_MAX_OUTPUT_BYTES
/** OCR helpers a search runs at once, whatever the PC offers. */
const MAX_HELPERS = 2
/** Pixels differing from the page's commonest grey by more than this are ink. */
const INK_CONTRAST = 32
/** A share of ink under this is a blank page, scanner noise included: not worth a helper run. */
const BLANK_INK = 0.00005

/** Lower case, Capitalised, ALL CAPS, a number, a code (A501, 10mm), or a script with no case. */
const WELL_FORMED =
  /^(?:\p{Ll}[\p{Ll}\p{M}]*|\p{Lu}[\p{Ll}\p{M}]*|\p{Lu}[\p{Lu}\p{M}]*|\p{N}+|\p{Lu}+\p{N}+|\p{N}+\p{L}{1,3}|[\p{Lo}\p{M}]+)$/u

/**
 * A token's parts between separators (A-501, 1284.50, 3/4) are each well-formed, once the
 * punctuation around it is off.
 */
function wellFormed(token: string): boolean {
  const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  return core !== '' && core.split(/[-./:,'’&+]/u).every((part) => WELL_FORMED.test(part))
}

/** Of the letters and digits OCR returned (`all`), how many are in well-formed words (`words`). */
export function readingScore(lines: readonly string[]): { words: number; all: number } {
  let words = 0
  let all = 0
  for (const line of lines) {
    for (const token of line.split(/\s+/u)) {
      const chars = token.match(/[\p{L}\p{N}]/gu)?.length ?? 0
      all += chars
      if ((chars >= 3 || (chars > 0 && WHOLE_CHARS.test(token))) && wellFormed(token)) {
        words += chars
      }
    }
  }
  return { words, all }
}

export const readsWell = ({ words, all }: { words: number; all: number }): boolean =>
  words >= GOOD_READING_CHARS && words >= all * GOOD_READING_SHARE

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

const turnTo = (image: OcrImage, turn: Turn): OcrImage =>
  turn === 0 ? image : turnGray(image, turn)

/** A grey image shrunk by `scale` (at most 1), each pixel the average of those it covers. */
export function shrinkGray(image: OcrImage, scale: number): OcrImage {
  const { width, height, pixels } = image
  const w = Math.max(1, Math.min(width, Math.round(width * scale)))
  const h = Math.max(1, Math.min(height, Math.round(height * scale)))
  if (w === width && h === height) return image
  // Each source column and row falls in one target column and row.
  const columnOf = new Uint32Array(width)
  const across = new Uint32Array(w)
  for (let x = 0; x < width; x++) {
    const to = Math.min(w - 1, Math.floor((x * w) / width))
    columnOf[x] = to
    across[to] = (across[to] ?? 0) + 1
  }
  const out = new Uint8Array(w * h)
  const sums = new Float64Array(w)
  let sy = 0
  for (let y = 0; y < h; y++) {
    sums.fill(0)
    let rows = 0
    for (; sy < height && Math.min(h - 1, Math.floor((sy * h) / height)) === y; sy++, rows++) {
      const row = sy * width
      for (let x = 0; x < width; x++) {
        const to = columnOf[x] ?? 0
        sums[to] = (sums[to] ?? 0) + (pixels[row + x] ?? 0)
      }
    }
    for (let x = 0; x < w; x++) {
      out[y * w + x] = Math.round((sums[x] ?? 0) / Math.max(1, (across[x] ?? 1) * rows))
    }
  }
  return { width: w, height: h, format: 'gray8', pixels: out }
}

/** Copies of a page stacked top to bottom, each turned its own way, for one helper run. */
export interface ProbeColumn {
  image: OcrImage
  /** Each copy's turn and rows, top to bottom. */
  tiles: { turn: Turn; top: number; height: number }[]
}

/** Stacks turned copies of a (shrunk) page with white rows between them, left-aligned. */
export function probeColumn(page: OcrImage, turns: readonly Turn[]): ProbeColumn {
  const copies = turns.map((turn) => ({ turn, image: turnTo(page, turn) }))
  const width = Math.max(...copies.map((copy) => copy.image.width))
  const height =
    copies.reduce((sum, copy) => sum + copy.image.height, 0) + PROBE_GUTTER * (copies.length - 1)
  const pixels = new Uint8Array(width * height).fill(255)
  const tiles: ProbeColumn['tiles'] = []
  let top = 0
  for (const { turn, image } of copies) {
    for (let y = 0; y < image.height; y++) {
      pixels.set(image.pixels.subarray(y * image.width, (y + 1) * image.width), (top + y) * width)
    }
    tiles.push({ turn, top, height: image.height })
    top += image.height + PROBE_GUTTER
  }
  return { image: { width, height, format: 'gray8', pixels }, tiles }
}

/**
 * The turns to probe, in as few helper runs as fit: each run a column of copies shrunk to
 * PROBE_SCALE, no taller than the helper takes.
 */
export function probeRuns(page: { width: number; height: number }, turns: readonly Turn[]) {
  const w = Math.max(1, Math.round(page.width * PROBE_SCALE))
  const h = Math.max(1, Math.round(page.height * PROBE_SCALE))
  const runs: Turn[][] = []
  let current: Turn[] = []
  let used = 0
  for (const turn of turns) {
    const tall = turn === 90 || turn === 270 ? w : h
    const added = current.length === 0 ? tall : used + PROBE_GUTTER + tall
    if (current.length > 0 && added > OCR_MAX_EDGE) {
      runs.push(current)
      current = [turn]
      used = tall
    } else {
      current.push(turn)
      used = added
    }
  }
  if (current.length > 0) runs.push(current)
  return runs
}

/**
 * The quarter turn that would set text upright, from the angle Windows reported for it
 * (clockwise degrees), or null when the angle is only a skew or there is none.
 */
export function turnFromAngle(angle: number | null): Turn | null {
  if (angle === null || !Number.isFinite(angle)) return null
  const quarter = Math.round(angle / 90)
  if (Math.abs(angle - quarter * 90) > ANGLE_SLACK) return null
  const turn = (((-quarter * 90) % 360) + 360) % 360
  return turn === 0 ? null : (turn as Turn)
}

/** How many pixels have each grey, and the commonest grey: the paper. */
function paperOf(pixels: Uint8Array): { counts: Uint32Array; paper: number } {
  const counts = new Uint32Array(256)
  for (const value of pixels) counts[value] = (counts[value] ?? 0) + 1
  let paper = 0
  for (let grey = 1; grey < 256; grey++) {
    if ((counts[grey] ?? 0) > (counts[paper] ?? 0)) paper = grey
  }
  return { counts, paper }
}

/** Which way a page's lines run: along its rows (upright or upside down) or its columns. */
export type Axis = 'rows' | 'columns'

/** The page is cut into squares this many to its shorter side to tell which way lines run. */
const AXIS_SQUARES = 10
/** A square smaller than this many pixels holds too little of a line to tell. */
const AXIS_SQUARE_MIN = 48
/** A square with ink between these shares can say which way its lines run. */
const AXIS_INK = [0.01, 0.4] as const
/** A square votes when its blank rows and blank columns differ by this share of its side. */
const AXIS_MARGIN = 0.1
/** Squares that must vote, and the share of their votes one way, to tell. */
const AXIS_VOTES = 3
const AXIS_AGREE = 0.75

/**
 * Which way a page's lines of text run, from its pixels alone, without a helper run; null
 * when it can't be told. Small squares of the page, each too small to be much skewed, are
 * looked at in turn: lines along the rows leave blank rows between them, and seldom a blank
 * column all the way through; lines along the columns, the other way round. A square with
 * one stray pixel in a row still counts it blank (scanner speckle). Ruled lines in drawings
 * vote too, both ways, which is why most of the votes must agree.
 */
export function textAxis(image: OcrImage): Axis | null {
  const { width, height, pixels } = image
  const side = Math.max(AXIS_SQUARE_MIN, Math.floor(Math.min(width, height) / AXIS_SQUARES))
  if (width < side || height < side || pixels.length < width * height) return null
  const { paper } = paperOf(pixels)
  const isInk = new Uint8Array(256)
  for (let grey = 0; grey < 256; grey++) isInk[grey] = Math.abs(grey - paper) > INK_CONTRAST ? 1 : 0
  const inRow = new Uint32Array(side)
  const inColumn = new Uint32Array(side)
  let rows = 0
  let columns = 0
  for (let top = 0; top + side <= height; top += side) {
    for (let left = 0; left + side <= width; left += side) {
      inRow.fill(0)
      inColumn.fill(0)
      let ink = 0
      for (let y = 0; y < side; y++) {
        const at = (top + y) * width + left
        for (let x = 0; x < side; x++) {
          if (isInk[pixels[at + x] ?? 0] === 1) {
            inRow[y] = (inRow[y] ?? 0) + 1
            inColumn[x] = (inColumn[x] ?? 0) + 1
            ink++
          }
        }
      }
      const share = ink / (side * side)
      if (share < AXIS_INK[0] || share > AXIS_INK[1]) continue
      let blankRows = 0
      let blankColumns = 0
      for (let i = 0; i < side; i++) {
        if ((inRow[i] ?? 0) <= 1) blankRows++
        if ((inColumn[i] ?? 0) <= 1) blankColumns++
      }
      const lean = (blankRows - blankColumns) / side
      if (lean > AXIS_MARGIN) rows++
      else if (lean < -AXIS_MARGIN) columns++
    }
  }
  const votes = rows + columns
  if (votes < AXIS_VOTES) return null
  if (rows >= votes * AXIS_AGREE) return 'rows'
  if (columns >= votes * AXIS_AGREE) return 'columns'
  return null
}

/** The share of a grey image's pixels that differ clearly from its commonest grey. */
export function inkShare(pixels: Uint8Array): number {
  if (pixels.length === 0) return 0
  const { counts, paper } = paperOf(pixels)
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
  /**
   * Background indexing only: true while it must make way (a search wants the reader and
   * helpers, or the user paused it). No new page starts; the pages being read finish and are
   * kept, so none is read twice.
   */
  pauseWhen?: () => boolean
  /** Saves the text in the cache; false when it was not kept. */
  keep: (text: CachedText) => Promise<boolean>
  run: OcrRun
}

export interface OcrDocumentResult {
  /**
   * 'finished': no page is waiting. 'time': out of time, 'cancelled': stopped; pending pages
   * are for later. 'gone': the folder's grant went, and nothing more was kept. 'off': the call
   * stopped trying (`run.off` says why). 'paused': `pauseWhen` said so; the pages being read
   * were finished and kept, and the pending ones are for later.
   */
  outcome: 'finished' | 'time' | 'cancelled' | 'gone' | 'off' | 'paused'
  /** Pages that failed in a way worth trying again: reported as failed, kept as pending. */
  failedNow: Set<number>
  /** Whether the last save worked: if not, the pages read since do not outlive this call. */
  kept: boolean
}

type PageRead = { kind: 'read'; text: string; low: boolean }
type PageOutcome =
  | PageRead
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

/** A reading of the whole page at one turn. */
interface Reading {
  turn: Turn
  lines: string[]
  score: { words: number; all: number }
  truncated: boolean
  /** The text angle Windows reported, clockwise degrees. */
  angle: number | null
}

/**
 * The turns a document's pages that read well needed, tried first on its next pages: the
 * last one, and the last one along each axis, for a page whose lines are seen to run that way.
 */
interface Orientation {
  turn: Turn
  rows: 0 | 180
  columns: 90 | 270
}

/** A page read before any of its document's pages read well. */
const NEW_ORIENTATION: Readonly<Orientation> = { turn: 0, rows: 0, columns: 90 }

/** What one page's OCR runs with: the call's job, stopped also when this document's OCR ends. */
interface PageJob extends OcrDocumentJob {
  /** The wall-clock limit of one helper run. */
  helperTimeoutMs: number
}

const probeReadsWell = ({ words, all }: { words: number; all: number }): boolean =>
  words >= PROBE_GOOD_CHARS && words >= all * GOOD_READING_SHARE

/** A page with this few characters in well-formed words, and little else, is a sparse one. */
const SPARSE_CHARS = 8
const readsSparse = ({ words, all }: { words: number; all: number }): boolean =>
  words >= SPARSE_CHARS && words >= all * GOOD_READING_SHARE

/**
 * Reads a page image the right way up, at the least cost in helper runs:
 * 0. which way its lines run is looked for in its pixels (textAxis), at no helper run. When
 *    it can be told, the page is read at the turn the document's last good page along that
 *    axis needed (as it is, or a quarter turn clockwise, for its first), then turned half
 *    round; one of them is right, so a page ends here in one or two runs, a sparse one too
 *    when it read some words. Only when neither read anything does it go on, as below.
 * 1. when it can't be told, at the turn the document's last good page needed (as it is, for
 *    its first): most pages end here, in one run, a run of sideways sheets included;
 * 2. if that gave little that looks like words, at the quarter turn Windows' reported text
 *    angle points to, when it points to one;
 * 3. then every other turn in one probe: copies shrunk to PROBE_SCALE, stacked in a column,
 *    read in one run (two for a big sheet), each copy scored by the lines inside it;
 * 4. then at full size at the turn the probe found best, when it read well there or found
 *    more words than the page has so far. If that full-size reading still falls short of a
 *    probe that read well, and of what the probe read at that turn, the probe misled: the turns left are read at full size, 90 and
 *    270 both and 180 if neither reads well, as before probes.
 * The text kept is always a full-size reading, the one with the most well-formed words.
 */
async function readImage(
  job: PageJob,
  image: OcrImage,
  orientation: Orientation,
): Promise<PageOutcome> {
  const recognize = async (input: OcrImage) => {
    const timeoutMs = Math.min(job.helperTimeoutMs, job.timeLeft())
    if (timeoutMs <= 0) throw new OcrError('timeout', 'No time left.')
    job.run.helperRuns++
    return job.ocr.recognize(input, { signal: job.signal, timeoutMs, background: true })
  }
  const tried = new Set<Turn>()
  const full = async (turn: Turn): Promise<Reading> => {
    tried.add(turn)
    const result = await recognize(turnTo(image, turn))
    const lines = result.lines.map((line) => line.text)
    return {
      turn,
      lines,
      score: readingScore(lines),
      truncated: result.truncated,
      angle: result.angle,
    }
  }
  /** Each turn's score, from copies of the page shrunk and read together. */
  const probe = async (turns: readonly Turn[]) => {
    const small = shrinkGray(image, PROBE_SCALE)
    const scores: { turn: Turn; score: { words: number; all: number } }[] = []
    for (const group of probeRuns(image, turns)) {
      const column = probeColumn(small, group)
      const result = await recognize(column.image)
      for (const tile of column.tiles) {
        const inside = result.lines.filter((line) => {
          const middle = line.box.y + line.box.height / 2
          return middle >= tile.top && middle < tile.top + tile.height
        })
        scores.push({ turn: tile.turn, score: readingScore(inside.map((line) => line.text)) })
      }
    }
    return scores
  }

  const axis = textAxis(image)
  const first = axis === null ? orientation.turn : orientation[axis]
  const turnBy = (degrees: number): Turn => ((first + degrees) % 360) as Turn
  let best: Reading
  try {
    best = await full(first)
  } catch (error) {
    return ocrFailure(error, job)
  }
  const consider = (reading: Reading): void => {
    if (reading.score.words > best.score.words) best = reading
  }
  try {
    if (axis !== null && !readsWell(best.score)) {
      // The other way up along the same axis: one of the two is right.
      consider(await full(turnBy(180)))
    }
    const settled = readsWell(best.score) || (axis !== null && readsSparse(best.score))
    const suggested = settled || axis !== null ? null : turnFromAngle(best.angle)
    if (suggested !== null) consider(await full(turnBy(suggested)))
    if (!settled && !readsWell(best.score)) {
      const others = [turnBy(90), turnBy(270), turnBy(180)]
      const scores = await probe(others.filter((turn) => !tried.has(turn)))
      const good = scores.filter((probed) => probeReadsWell(probed.score))
      const pool = good.length > 0 ? good : scores.filter((p) => p.score.words > best.score.words)
      const pick = pool.reduce<(typeof pool)[number] | null>(
        (top, probed) => (top === null || probed.score.words > top.score.words ? probed : top),
        null,
      )
      if (pick) {
        const atPick = await full(pick.turn)
        consider(atPick)
        // A sparse page reads at full size at least what its probe did: that is no misleading.
        if (
          !readsWell(best.score) &&
          probeReadsWell(pick.score) &&
          atPick.score.words < pick.score.words
        ) {
          for (const turn of others) {
            if (tried.has(turn)) continue
            // 90 and 270 are always both read: one of them is upside down, which reads as
            // plausible letters, so the one that reads well first is not yet the right one.
            if (turn === turnBy(180) && readsWell(best.score)) break
            consider(await full(turn))
          }
        }
      }
    }
  } catch (error) {
    const failure = ocrFailure(error, job)
    if (failure.kind !== 'failed') return failure
    // The page has its reading; a turned copy that fails adds nothing to it.
  }
  if (readsWell(best.score)) {
    orientation.turn = best.turn
    if (best.turn === 0 || best.turn === 180) orientation.rows = best.turn
    else orientation.columns = best.turn
  }
  return {
    kind: 'read',
    text: best.lines.join('\n'),
    low: !readsWell(best.score) || best.truncated,
  }
}

const charsOf = (text: CachedText): number =>
  text.segments.reduce((sum, segment) => sum + segment.text.length, 0) +
  text.ocr.reduce((sum, page) => sum + page.text.length, 0)

/**
 * Reads a document's pending pages in order until none is left, the time runs out, the
 * search stops or the PC goes on battery. A pipeline, bounded at every step:
 * - the reader renders one page at a time, as one background job, the next while the helper
 *   reads the last, so a read_document waits behind one page's job at most, as before;
 * - at most two rendered pages are held at once, the one being read and the next;
 * - up to `ocr.helpers` helpers (two at most, at a low priority) read pages side by side.
 * Pages may finish out of order, but the document's character limit is spent in page order,
 * as one page after the other would spend it: a later page is kept ahead of an earlier one
 * still being read only when that can't leave the earlier one short (PAGE_TEXT_MOST each),
 * and waits for it otherwise. What is kept is saved every few seconds and whenever it stops,
 * so a page is read once and a later call picks up the rest. Stop,
 * a removed grant, the deadline or OCR failing stops every helper at once; on battery, no
 * new page is started and the ones being read are finished.
 */
export async function ocrDocument(job: OcrDocumentJob): Promise<OcrDocumentResult> {
  const { text, run } = job
  const helpers = Math.max(1, Math.min(MAX_HELPERS, Math.floor(job.ocr.helpers ?? 1)))
  const stop = new AbortController()
  const pageJob: PageJob = {
    ...job,
    signal: AbortSignal.any([job.signal, stop.signal]),
    // Helpers sharing the processors at a low priority each get the time they would take one
    // after the other; the helper's own limit of 60 s of CPU per image is unchanged.
    helperTimeoutMs: OCR_DEFAULT_TIMEOUT_MS * helpers,
  }
  const orientation: Orientation = { ...NEW_ORIENTATION }
  const failedNow = new Set<number>()
  let kept = true
  let dirty = false
  let saved = job.now()
  let saving: Promise<void> = Promise.resolve()
  const failedSave: { error?: unknown; failed: boolean } = { failed: false }
  const save = (): Promise<void> => {
    saving = saving.then(async () => {
      if (!dirty) return
      dirty = false
      try {
        kept = await job.keep(text)
      } catch (error) {
        if (!failedSave.failed) Object.assign(failedSave, { error, failed: true })
      }
      saved = job.now()
    })
    return saving
  }
  const saveNow = async (): Promise<void> => {
    if (job.now() - saved >= SAVE_EVERY_MS) await save()
  }

  /** Why this document's OCR ended, once it has. */
  const ended: { outcome: OcrDocumentResult['outcome'] | null } = { outcome: null }
  /** Ends this document's OCR; unless `finishing`, the pages being read are stopped too. */
  const finish = (outcome: OcrDocumentResult['outcome'], finishing = false): void => {
    if (ended.outcome !== null) return
    ended.outcome = outcome
    if (!finishing) stop.abort()
  }
  /** Whether another page may start, ending the OCR when it may not. */
  const ready = (): boolean => {
    if (ended.outcome !== null) return false
    if (job.signal.aborted) finish('cancelled')
    else if (!job.stillGranted()) finish('gone')
    else if (job.timeLeft() <= 0) finish('time')
    else if (job.pauseWhen?.() === true) finish('paused', true)
    else if (job.ocr.onBattery?.() === true) {
      run.off = 'on-battery'
      run.offMessage = OCR_ON_BATTERY
      finish('off', true)
    } else return true
    return false
  }

  /**
   * A page started, until its share of the character limit is settled and countStreak has
   * counted it.
   */
  interface Slot {
    page: OcrPage
    state: 'reading' | 'read' | 'gap'
    read?: PageRead
    /**
     * What the page does to the failures in a row, once known: a page kept resets them, one
     * that failed in a way worth trying again adds one, a lasting failure or a page past the
     * limit does neither.
     */
    streak?: 'reset' | 'failure' | 'none'
  }
  let chars = charsOf(text)
  /** Past the document's character limit, a page is not read: marks it so. */
  const tooLong = (page: OcrPage): boolean => {
    if (chars < job.maxChars) return false
    page.state = 'failed'
    page.failure = 'too-long'
    dirty = true
    return true
  }
  /** Keeps a page's reading: in page order, so the limit cuts what serial reading would. */
  const commit = (slot: Slot, outcome: PageRead): void => {
    const { page } = slot
    if (tooLong(page)) {
      slot.streak = 'none'
      return
    }
    slot.streak = 'reset'
    page.state = 'done'
    page.text = outcome.text.slice(0, Math.max(0, job.maxChars - chars))
    page.low = outcome.low
    chars += page.text.length
    dirty = true
    run.pagesRead++
  }
  const record = (page: OcrPage, outcome: Exclude<PageOutcome, PageRead>): void => {
    // An outcome that came after the grant went is not kept (put refuses it too), nor reported.
    if (ended.outcome === 'gone' || ended.outcome === 'cancelled') return
    if (!job.stillGranted()) {
      finish('gone')
      return
    }
    switch (outcome.kind) {
      case 'stop':
        if (job.signal.aborted) finish('cancelled')
        else if (outcome.why === 'time') finish('time')
        // Otherwise this document's OCR stopped it, for a reason it already has.
        return
      case 'off':
        if (ended.outcome === null) {
          run.off = outcome.reason
          run.offMessage = outcome.message
        }
        finish('off')
        return
      case 'failed':
        if (outcome.lasting) {
          page.state = 'failed'
          page.failure = outcome.code
          dirty = true
        } else {
          failedNow.add(page.page)
        }
        // Counted towards failures in a row by countStreak, in page order.
        return
    }
  }

  /**
   * Pages started, in page order, until their share of the character limit is settled:
   * being read, read and waiting for an earlier page, or a gap (an earlier page left
   * pending by Stop, the deadline or OCR going off, which a later call reads first).
   */
  const slots: Slot[] = []
  /** Every page started, in page order, until countStreak has counted it. */
  const unstreaked: Slot[] = []
  /**
   * Counts failures in a row in page order, over the pages whose outcome is known up to the
   * first that is not, as reading one page after the other would count them. So a later page
   * failing before an earlier one is read can't stop OCR that the earlier one would have
   * kept going, and three failures in a row in page order stop it however they finished.
   * One such failure is a page; three in a row, and OCR itself is what is wrong, however many
   * pages are left. A page that fails for good only costs its own time, once.
   */
  const countStreak = (): void => {
    for (let slot = unstreaked[0]; slot?.streak !== undefined; slot = unstreaked[0]) {
      unstreaked.shift()
      if (slot.streak === 'reset') run.failuresInARow = 0
      else if (
        slot.streak === 'failure' &&
        ++run.failuresInARow >= MAX_FAILURES_IN_A_ROW &&
        ended.outcome === null
      ) {
        run.off = 'failed'
        finish('off')
      }
    }
  }
  /** Keeps every reading that can be kept now without taking what an earlier page may need. */
  const settle = (): void => {
    if (!job.stillGranted()) return
    let ahead = 0
    for (let i = 0; i < slots.length;) {
      const slot = slots[i]
      if (!slot) break
      const read = slot.state === 'read' ? slot.read : undefined
      if (
        read &&
        (ahead === 0 || chars + ahead * PAGE_TEXT_MOST + read.text.length <= job.maxChars)
      ) {
        commit(slot, read)
        slots.splice(i, 1)
        continue
      }
      ahead++
      i++
    }
  }
  /** A started page's outcome: kept in page order, or recorded at once if it takes no text. */
  const resolve = (slot: Slot, outcome: PageOutcome): void => {
    if (outcome.kind === 'read') {
      // Whether it is kept is decided now, as it finishes, however long it then waits.
      if (ended.outcome === 'gone' || ended.outcome === 'cancelled') slot.state = 'gap'
      else if (!job.stillGranted()) {
        finish('gone')
        slot.state = 'gap'
      } else {
        slot.state = 'read'
        slot.read = outcome
      }
    } else {
      record(slot.page, outcome)
      // A failed page takes no text, now or later; a stopped one may, on a later call.
      if (outcome.kind === 'failed') {
        slots.splice(slots.indexOf(slot), 1)
        slot.streak = outcome.lasting ? 'none' : 'failure'
      } else slot.state = 'gap'
    }
    settle()
    countStreak()
  }

  /** Pages being read by a helper, each holding its rendered image. */
  const reading = new Set<Promise<void>>()
  const room = async (most: number): Promise<void> => {
    while (reading.size >= most) await Promise.race(reading)
  }
  for (const page of text.ocr) {
    if (page.state !== 'pending') continue
    // The page about to be rendered is the second image held, at most.
    await room(MAX_IMAGES)
    if (!ready()) break
    if (tooLong(page)) continue
    const slot: Slot = { page, state: 'reading' }
    slots.push(slot)
    unstreaked.push(slot)
    const raster = await renderForOcr(pageJob, page)
    if ('kind' in raster) {
      resolve(slot, raster)
      if (ended.outcome !== null) break
      await saveNow()
      continue
    }
    if (inkShare(raster.pixels) < BLANK_INK) {
      resolve(slot, { kind: 'read', text: '', low: false })
      await saveNow()
      continue
    }
    await room(helpers)
    // Rendered but not started: it stays pending for a later call.
    if (!ready()) {
      slot.state = 'gap'
      break
    }
    if (tooLong(page)) {
      slots.splice(slots.indexOf(slot), 1)
      slot.streak = 'none'
      countStreak()
      continue
    }
    const image: OcrImage = {
      width: raster.width,
      height: raster.height,
      format: 'gray8',
      pixels: raster.pixels,
    }
    const task: Promise<void> = readImage(pageJob, image, orientation)
      .catch((): PageOutcome => ({ kind: 'failed', code: 'failed', lasting: false }))
      .then(async (outcome) => {
        resolve(slot, outcome)
        await saveNow()
      })
      .finally(() => {
        reading.delete(task)
      })
    reading.add(task)
  }
  await Promise.all(reading)
  // A reading still waiting here is behind a page left pending: it is read again, in order.
  if (ended.outcome === 'gone' || !job.stillGranted()) {
    return { outcome: 'gone', failedNow, kept: false }
  }
  await save()
  if (failedSave.failed) throw failedSave.error
  return { outcome: ended.outcome ?? 'finished', failedNow, kept }
}
