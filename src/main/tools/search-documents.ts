// search_files' document phase: the text of PDFs, Word, Excel, PowerPoint and OpenDocument
// files, read through the same sandboxed document reader as read_document (main never
// parses a document), a call at a time, as plain lines with where each one is.
import { DEFAULT_LIMITS as DOCUMENT_LIMITS, SCAN_IMAGE_COVERAGE } from '../documents/limits'
import {
  DocumentError,
  type DocumentErrorCode,
  type DocumentKind,
  type DocumentReader,
  type DocumentView,
  type ExtractOptions,
  type PageLayout,
} from '../documents/types'
import type { CachedText, OcrPage, TextSegment } from './document-text-cache'

/** Kinds whose text search_files reads. Not images, and not .ppt, which the reader refuses. */
const SEARCHABLE_KINDS = new Set<DocumentKind>([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'ooxml',
  'odf',
  'odt',
  'ods',
  'odp',
  'ole',
  'doc',
  'xls',
  'csv',
])

export const searchableKind = (kind: DocumentKind): boolean => SEARCHABLE_KINDS.has(kind)

/** Extensions of documents searched by text, for files too large to sniff in the text pass. */
export const SEARCHABLE_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'docm',
  'xls',
  'xlsx',
  'xlsm',
  'pptx',
  'odt',
  'ods',
  'odp',
  'csv',
])

/** A PDF page with fewer non-space characters than this has no text layer to speak of. */
const BLANK_PAGE = 8
/** Over a page-sized image, fewer non-space characters than this are a stamp or a footer. */
const STAMP_CHARS = 200
/** Over a page-sized image, text covering less of the page than this is a stamp or a footer. */
const STAMP_TEXT_COVERAGE = 0.05

/**
 * Whether a PDF page needs OCR, decided per page from what the reader says is on it (main
 * never parses the PDF):
 * - 'no-text': fewer than 8 non-space characters and something drawn (an image, or paths,
 *   which may be a CAD drawing's outlined text). A page with neither is simply blank.
 * - 'stamp': images cover at least half the page and the text is small: under 200 non-space
 *   characters, or covering under 5% of the page (a big "RECEIVED", a long footer). A scan
 *   with a real OCR layer has far more than that, so it stays a text page.
 * A wrong 'stamp' costs one page's OCR and repeats some lines as "(page N, OCR)" matches; a
 * wrong text page would hide the scan, so the rule leans towards OCR. The page's own text
 * stays searched either way. A reader without layouts (a fake, in tests) gets the first rule.
 */
export function ocrReason(text: string, layout?: PageLayout): OcrPage['reason'] | null {
  const chars = text.replace(/\s/g, '').length
  if (chars < BLANK_PAGE) return !layout || layout.ink ? 'no-text' : null
  if (!layout || layout.imageCoverage < SCAN_IMAGE_COVERAGE) return null
  return chars < STAMP_CHARS || layout.textCoverage < STAMP_TEXT_COVERAGE ? 'stamp' : null
}

/** The long edge, in pixels, an ordinary page is rendered at for OCR. */
const OCR_EDGE = 2200
/** A big sheet's (drawings): labels read better up to about this size, and no better past it. */
const OCR_EDGE_LARGE = 3300
/** Past this long edge in points (A4 is 842, US Letter 792, 11x17 1224), a sheet counts as big. */
const LARGE_PAGE_POINTS = 900

const ocrEdge = (layout?: PageLayout): number =>
  layout && layout.longEdgePoints > LARGE_PAGE_POINTS ? OCR_EDGE_LARGE : OCR_EDGE

/**
 * Smallest file taken for a cloud-only placeholder. NTFS keeps files of up to about 700
 * bytes (a few KB on 4K-record volumes) inside the MFT, where they have no allocation
 * either, so small files are never taken for placeholders.
 */
const CLOUD_ONLY_MIN_SIZE = 4096n

/**
 * Whether a file is a OneDrive (or other cloud files provider) placeholder whose content
 * is not on this PC, so reading it would download it. Node does not expose Windows file
 * attributes (RECALL_ON_DATA_ACCESS, OFFLINE), but libuv reports the allocation size as
 * `blocks`: a dehydrated placeholder has a size and no allocation ("size on disk: 0").
 * So does a sparse file that was never written, which is no loss to a search.
 *
 * A guess, so the skip says how to get the file read anyway. Never made on a UNC path
 * (\\server\share, \\?\UNC\…), where the server's file system decides what the
 * allocation size says; a network share mapped to a drive letter cannot be told apart
 * cheaply and is still guessed at.
 */
export function isCloudOnly(
  entry: { path: string; size: number; blocks: bigint },
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'win32' || isUncPath(entry.path)) return false
  return entry.blocks === 0n && BigInt(entry.size) >= CLOUD_ONLY_MIN_SIZE
}

/** \\server\share\…, //server/share/… or \\?\UNC\server\share\…; not \\?\C:\…. */
function isUncPath(path: string): boolean {
  if (!/^[\\/]{2}/.test(path)) return false
  return !/^[\\/]{2}[?.][\\/][A-Za-z]:/.test(path)
}

/** Refusals that will not change until the file does: kept in the cache like text. */
export const LASTING: ReadonlySet<DocumentErrorCode> = new Set([
  'password-protected',
  'malformed',
  'zip-bomb',
  'unsupported',
  'too-large',
  'too-many-pixels',
  'timeout',
  'memory',
])

export const FAILURE_LABEL: Record<string, string> = {
  'password-protected': 'password-protected',
  malformed: 'damaged or not a readable document',
  'zip-bomb': 'refused by the reader’s size checks',
  unsupported: 'a format the reader does not support',
  'too-large': 'too large for the reader',
  'too-many-pixels': 'too large for the reader',
  timeout: 'took too long to read',
  memory: 'needed too much memory to read',
  'worker-failed': 'the document reader failed',
  'out-of-range': 'the document reader failed',
}

/** How long a search waits before sending a document again to a reader that was busy. */
export const BUSY_RETRY_MS = 250

/** Waits `ms` (at most until the deadline), or less when the signal aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export interface ExtractBudget {
  /** Characters of text kept from one document; the rest is not searched. */
  maxChars: number
  /** Reader calls for one document (pages, slides or cells come a part per call). */
  maxCalls: number
}

const EMPTY: CachedText = {
  kind: 'unknown',
  segments: [],
  ocr: [],
  truncated: null,
  failure: null,
}

export type ExtractOutcome =
  | { kind: 'text'; text: CachedText; cacheable: boolean }
  /** `busy`: the reader refused the job (an earlier search's job is still in it, or it is full). */
  | { kind: 'stopped'; why: 'time' | 'cancelled' | 'busy' }

/**
 * A reader call made as a background job, given up on at the deadline or a cancel. A job
 * still waiting in the reader's queue then leaves it; one already running cannot be
 * stopped and finishes (or times out) on its own, its result thrown away: it is one part
 * of a document, not the whole text the cache keeps. Until it ends the reader refuses
 * any other search's job, so abandoned jobs never pile up.
 */
export async function within(
  reader: DocumentReader,
  bytes: Uint8Array,
  options: ExtractOptions,
  timeLeft: () => number,
  signal: AbortSignal,
): Promise<DocumentView | 'time' | 'cancelled'> {
  const ms = timeLeft()
  if (ms <= 0) return 'time'
  if (signal.aborted) return 'cancelled'
  const stop = new AbortController()
  const work = reader.extract(bytes, options, { background: true, signal: stop.signal })
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const outcome = await Promise.race([
      work,
      new Promise<'time'>((resolve) => {
        timer = setTimeout(() => {
          resolve('time')
        }, ms)
      }),
      new Promise<'cancelled'>((resolve) => {
        onAbort = () => {
          resolve('cancelled')
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    if (outcome === 'time' || outcome === 'cancelled') stop.abort()
    return outcome
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** A sheet reference read_document's ranges accept: quoted when the name needs it. */
export function sheetRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/** The cells of a sheet table (sheets.ts' Markdown) as `A1<TAB>value` lines, empty cells left out. */
export function tableCells(table: string): string {
  const rows = table.split('\n')
  const columns = splitRow(rows[0] ?? '')
  const out: string[] = []
  for (const line of rows.slice(2)) {
    const cells = splitRow(line)
    const row = cells[0] ?? ''
    if (!/^[1-9][0-9]{0,6}$/.test(row)) continue
    for (let i = 1; i < cells.length; i++) {
      const column = columns[i] ?? ''
      const value = (cells[i] ?? '').replace(/<br>/g, ' ').trim()
      if (value && /^[A-Z]{1,3}$/.test(column)) out.push(`${column}${row}\t${value}`)
    }
  }
  return out.join('\n')
}

/** A table row's cells: `|` separates them unless escaped as `\|`; `\\` is a backslash. */
function splitRow(line: string): string[] {
  if (!line.startsWith('|')) return []
  const cells: string[] = []
  let current = ''
  for (let i = 1; i < line.length; i++) {
    const char = line.charAt(i)
    if (char === '\\' && i + 1 < line.length) {
      current += line.charAt(i + 1)
      i++
    } else if (char === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) cells.push(current.trim())
  return cells
}

/**
 * The searchable text of a document, read with the reader's text view a part at a time:
 * PDF pages and slides by `start`, flowing text by character, and every sheet's used range
 * by `range`. Stops at the per-document budget (the result says what was read) or, without
 * a result, at the search's deadline or a cancel.
 */
export async function extractForSearch(
  reader: DocumentReader,
  bytes: Uint8Array,
  name: string,
  budget: ExtractBudget,
  timeLeft: () => number,
  signal: AbortSignal,
): Promise<ExtractOutcome> {
  const segments: TextSegment[] = []
  let chars = 0
  let calls = 0
  let truncated: string | null = null
  const read = async (select?: ExtractOptions['select']) => {
    calls++
    const options: ExtractOptions = {
      name,
      view: 'text',
      pageLayout: true,
      budget: { maxChars: DOCUMENT_LIMITS.maxCharsPerCall, maxImages: 0 },
      ...(select ? { select } : {}),
    }
    return within(reader, bytes, options, timeLeft, signal)
  }
  const add = (segment: TextSegment): boolean => {
    const room = budget.maxChars - chars
    if (segment.text.length > room) segment.text = segment.text.slice(0, Math.max(0, room))
    chars += segment.text.length
    if (segment.text) segments.push(segment)
    return chars < budget.maxChars
  }
  const failed = (error: unknown): ExtractOutcome => {
    const code: DocumentErrorCode = error instanceof DocumentError ? error.code : 'worker-failed'
    // Nothing to do with this document: the next search reads it.
    if (code === 'busy' || code === 'cancelled') return { kind: 'stopped', why: 'busy' }
    return {
      kind: 'text',
      text: { ...EMPTY, failure: code },
      cacheable: LASTING.has(code),
    }
  }

  let view: DocumentView | 'time' | 'cancelled'
  try {
    view = await read()
  } catch (error) {
    return failed(error)
  }
  if (view === 'time' || view === 'cancelled') return { kind: 'stopped', why: view }
  const kind = view.meta.kind
  if (!searchableKind(kind)) {
    return {
      kind: 'text',
      text: { ...EMPTY, kind, failure: 'unsupported' },
      cacheable: true,
    }
  }
  const unit = view.position.unit
  const ocr: OcrPage[] = []
  try {
    if (unit === 'sheet') {
      const sheets = view.meta.sheets ?? []
      outer: for (const sheet of sheets) {
        let range = sheet.used
        while (range) {
          if (calls >= budget.maxCalls) {
            truncated = `stopped in sheet "${sheet.name}"`
            break outer
          }
          const ref = kind === 'csv' ? range : `${sheetRef(sheet.name)}!${range}`
          const part = await read({ range: ref })
          if (part === 'time' || part === 'cancelled') return { kind: 'stopped', why: part }
          const section = part.sections.find((s) => s.sheet)
          if (!section?.sheet) break
          const more = add({
            at: kind === 'csv' ? '' : section.sheet.name,
            cells: true,
            text: tableCells(section.text),
          })
          if (!more) {
            truncated = `stopped in sheet "${sheet.name}"`
            break outer
          }
          range = section.sheet.next ?? null
        }
      }
    } else if (unit === 'page' || unit === 'slide' || unit === 'char') {
      for (;;) {
        for (const section of view.sections) {
          let more: boolean
          if (unit === 'char') {
            more = add({
              at: '',
              offset: Math.max(1, view.position.shown.from),
              text: section.text,
            })
          } else {
            const number = section.page ?? 0
            const reason =
              kind === 'pdf' && unit === 'page' ? ocrReason(section.text, section.layout) : null
            if (reason) {
              ocr.push({
                page: number,
                reason,
                longEdge: ocrEdge(section.layout),
                state: 'pending',
                text: '',
                low: false,
                failure: null,
              })
            }
            more = add({ at: `${unit} ${String(number)}`, text: section.text })
          }
          if (!more) {
            truncated = `stopped at ${unit === 'char' ? 'character' : unit} ${String(
              unit === 'char'
                ? view.position.shown.from + section.text.length
                : (section.page ?? 0),
            )} of ${String(view.position.total)}`
            break
          }
        }
        const next = view.position.next
        if (truncated !== null || next === null) break
        if (calls >= budget.maxCalls) {
          truncated = `stopped at ${unit === 'char' ? 'character' : unit} ${String(next - 1)} of ${String(view.position.total)}`
          break
        }
        const part = await read({ from: next })
        if (part === 'time' || part === 'cancelled') return { kind: 'stopped', why: part }
        view = part
      }
    }
  } catch (error) {
    return failed(error)
  }
  return {
    kind: 'text',
    text: {
      kind,
      segments,
      ocr,
      truncated,
      failure: null,
    },
    cacheable: true,
  }
}

/** Where a line of a segment is, as the search reports it ('' when the reader gave nothing). */
export interface DocumentLine {
  at: string
  text: string
  /** Which segment (page, slide, sheet part or run of text) the line is in: context stays inside one. */
  segment: number
  /** A sheet cell: never matched together with the line before it. */
  cell?: true
}

/** What OCR read as a segment of its own, located "page 3, OCR". */
const ocrSegment = (page: OcrPage): TextSegment => ({
  at: `page ${String(page.page)}, OCR`,
  text: page.text,
})

const pageNumberOf = (segment: TextSegment): number =>
  Number(/^page (\d+)/.exec(segment.at)?.[1] ?? 0)

/** A document's segments with OCR text among them, a page's text layer before its OCR. */
function allSegments(text: CachedText): TextSegment[] {
  const read = text.ocr.filter((page) => page.state === 'done' && page.text)
  if (read.length === 0) return text.segments
  return [...text.segments, ...read.map(ocrSegment)].sort(
    (a, b) => pageNumberOf(a) - pageNumberOf(b),
  )
}

/** Every line of a document's text with its location: page, slide, sheet!cell or character. */
export function documentLines(text: CachedText, maxLine: number): DocumentLine[] {
  const lines: DocumentLine[] = []
  for (const [index, segment] of allSegments(text).entries()) {
    let position = 0
    for (let line of segment.text.split('\n')) {
      const start = position
      position += line.length + 1
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line.trim()) continue
      if (segment.cells) {
        const tab = line.indexOf('\t')
        if (tab <= 0) continue
        const cell = line.slice(0, tab)
        lines.push({
          at: segment.at ? `${sheetRef(segment.at)}!${cell}` : cell,
          text: line.slice(tab + 1, tab + 1 + maxLine),
          segment: index,
          cell: true,
        })
      } else if (segment.offset !== undefined) {
        lines.push({
          at: `character ${String(segment.offset + start)}`,
          text: line.slice(0, maxLine),
          segment: index,
        })
      } else {
        lines.push({ at: segment.at, text: line.slice(0, maxLine), segment: index })
      }
    }
  }
  return lines
}
