// search_files' document phase: the text of PDFs, Word, Excel, PowerPoint and OpenDocument
// files, read through the same sandboxed document reader as read_document (main never
// parses a document), a call at a time, as plain lines with where each one is.
import { DEFAULT_LIMITS as DOCUMENT_LIMITS } from '../documents/limits'
import {
  DocumentError,
  type DocumentErrorCode,
  type DocumentKind,
  type DocumentReader,
  type DocumentView,
  type ExtractOptions,
} from '../documents/types'
import type { CachedText, TextSegment } from './document-text-cache'

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

/**
 * A PDF page with fewer non-space characters than this has no text layer to speak of: at
 * most a stamp or a page number on a scan.
 */
const BLANK_PAGE = 8

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
 */
export function isCloudOnly(
  entry: { size: number; blocks: bigint },
  platform: NodeJS.Platform,
): boolean {
  return platform === 'win32' && entry.blocks === 0n && BigInt(entry.size) >= CLOUD_ONLY_MIN_SIZE
}

/** Refusals that will not change until the file does: kept in the cache like text. */
const LASTING: ReadonlySet<DocumentErrorCode> = new Set([
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

export interface ExtractBudget {
  /** Characters of text kept from one document; the rest is not searched. */
  maxChars: number
  /** Reader calls for one document (pages, slides or cells come a part per call). */
  maxCalls: number
}

const EMPTY: CachedText = {
  kind: 'unknown',
  segments: [],
  scanned: false,
  blankPages: 0,
  truncated: null,
  failure: null,
}

export type ExtractOutcome =
  | { kind: 'text'; text: CachedText; cacheable: boolean }
  | { kind: 'stopped'; why: 'time' | 'cancelled' }

/** A reader call that is given up on (not stopped: the reader has no cancel) at the deadline. */
async function within(
  work: Promise<DocumentView>,
  timeLeft: () => number,
  signal: AbortSignal,
): Promise<DocumentView | 'time' | 'cancelled'> {
  work.catch(() => undefined)
  const ms = timeLeft()
  if (ms <= 0) return 'time'
  if (signal.aborted) return 'cancelled'
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
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
      budget: { maxChars: DOCUMENT_LIMITS.maxCharsPerCall, maxImages: 0 },
      ...(select ? { select } : {}),
    }
    return within(reader.extract(bytes, options), timeLeft, signal)
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
  let pages = 0
  let blankPages = 0
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
            pages++
            if (unit === 'page' && section.text.replace(/\s/g, '').length < BLANK_PAGE) blankPages++
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
  const scanned = kind === 'pdf' && pages > 0 && blankPages === pages
  return {
    kind: 'text',
    text: {
      kind,
      segments,
      scanned,
      blankPages: scanned ? 0 : blankPages,
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
}

/** Every line of a document's text with its location: page, slide, sheet!cell or character. */
export function documentLines(text: CachedText, maxLine: number): DocumentLine[] {
  const lines: DocumentLine[] = []
  for (const segment of text.segments) {
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
        })
      } else if (segment.offset !== undefined) {
        lines.push({
          at: `character ${String(segment.offset + start)}`,
          text: line.slice(0, maxLine),
        })
      } else {
        lines.push({ at: segment.at, text: line.slice(0, maxLine) })
      }
    }
  }
  return lines
}
