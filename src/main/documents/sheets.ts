import * as XLSX from 'xlsx'
import { escapeCell } from './docx'
import { effectiveBudget, type DocumentLimits } from './limits'
import type { OfficePackage } from './package'
import { MIME } from './sniff'
import {
  DocumentError,
  type DocumentKind,
  type DocumentSection,
  type DocumentView,
  type ExtractOptions,
  type SheetInfo,
  type SheetPart,
} from './types'
import {
  MAX_COLUMNS,
  MAX_ROWS,
  unsavedOds,
  unsavedXlsx,
  type Recorder,
  type UnsavedCells,
} from './unsaved'
import { decodeXml, refuseDtd } from './xml'

/**
 * Workbooks: Excel (.xlsx, .xlsm, .xls), OpenDocument spreadsheets (.ods) and CSV, as
 * Markdown tables whose first column is the row number and whose header is the column
 * letters, so every cell has its address. With no sheet or range the reader lists every
 * sheet and shows the first rows of each; a range (`Sheet1!A1:H200`) reads those cells,
 * at most `office.maxCellsPerCall` of them and within the text budget, and names the
 * range to read next. Formulas show their cached values (the text of the formula with
 * `includeFormulas`, or when there is no value); nothing is ever recalculated or run. A
 * formula saved without a result shows as `=SUM(A1:A3) (no saved value)`, never as a
 * number that was not stored (unsaved.ts finds them in the raw XML).
 *
 * SheetJS parses the sheets, but never sees the ZIP: the package's parts are inflated by
 * the guarded reader (package.ts) and handed over as an in-memory container, so the
 * archive limits apply to every byte. Parts that declare a DTD are refused first. Macro
 * projects, pictures and embedded objects are never handed over at all.
 */

interface Range {
  r0: number
  c0: number
  r1: number
  c1: number
}

/** What a sheet looks like to the table writer, whatever parsed it. */
interface Grid {
  name: string
  used: Range | null
  hidden?: boolean
  cell: (row: number, column: number) => string
}

/** Part names SheetJS needs from a package; everything else (media, macros, embeddings) stays behind. */
const NEEDED =
  /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/[^/]+\.xml|xl\/(?:_rels\/)?[^/]+\.(?:xml|rels)|xl\/worksheets\/[^/]+\.xml|mimetype|content\.xml|styles\.xml|meta\.xml|settings\.xml|META-INF\/manifest\.xml)$/i

type SheetJs = typeof XLSX & {
  parse_zip: (zip: unknown, options: XLSX.ParsingOptions) => XLSX.WorkBook
}
const sheetjs = XLSX as SheetJs

/** An OLE or ZIP container as SheetJS's CFB library holds it. */
export interface CfbContainer {
  FileIndex: { name: string; type: number; content?: Uint8Array | number[] }[]
  FullPaths: string[]
}
/** The parts of SheetJS's CFB library the readers (and their test fixtures) use; untyped upstream. */
export const CFB = XLSX.CFB as {
  read: (data: Uint8Array, options: { type: 'array' }) => CfbContainer
  write: (container: CfbContainer, options: { type: 'array' }) => ArrayLike<number>
  utils: {
    cfb_new: () => CfbContainer
    cfb_add: (container: CfbContainer, name: string, content: Uint8Array) => void
  }
}

/** Reads an OOXML or ODF workbook from its package. */
export async function extractPackageWorkbook(
  pkg: OfficePackage,
  kind: 'xlsx' | 'ods',
  options: ExtractOptions,
  limits: DocumentLimits,
): Promise<DocumentView> {
  const container = CFB.utils.cfb_new()
  const recorder: Recorder = { runs: 0 }
  const byPart = new Map<string, UnsavedCells>()
  let unsaved = new Map<string, UnsavedCells>()
  for (const name of pkg.names()) {
    if (!NEEDED.test(name)) continue
    const bytes = await pkg.read(name)
    if (!bytes) continue
    if (name !== 'mimetype') refuseDtd(dtdProbe(bytes), `"${name}"`)
    if (kind === 'xlsx' && /^xl\/worksheets\/[^/]+\.xml$/i.test(name)) {
      byPart.set(name.toLowerCase(), unsavedXlsx(decodeXml(bytes), recorder))
    } else if (kind === 'ods' && name === 'content.xml') {
      unsaved = unsavedOds(decodeXml(bytes), recorder)
    }
    CFB.utils.cfb_add(container, `/${name}`, bytes)
  }
  if (byPart.size > 0) unsaved = await sheetsByName(pkg, byPart)
  const warnings: string[] = []
  if (pkg.has('xl/vbaProject.bin')) {
    warnings.push('The workbook contains macros; they were not run or read.')
  }
  const view = readWorkbook(
    kind,
    (parse) => sheetjs.parse_zip(container, parse),
    options,
    limits,
    unsaved,
  )
  view.warnings.unshift(...warnings)
  return view
}

/** Worksheet parts' findings keyed by the sheet names the workbook part gives them. */
async function sheetsByName(
  pkg: OfficePackage,
  byPart: Map<string, UnsavedCells>,
): Promise<Map<string, UnsavedCells>> {
  const out = new Map<string, UnsavedCells>()
  const root = await pkg.relationships('')
  const main =
    [...root.values()].find((rel) => rel.type.endsWith('/officeDocument'))?.target ??
    'xl/workbook.xml'
  const local = (name: string): string => name.slice(name.indexOf(':') + 1)
  const book = await pkg.xml(main, { keep: (name) => local(name) === 'sheet' })
  const rels = await pkg.relationships(main)
  for (const sheet of book?.children ?? []) {
    if (typeof sheet === 'string') continue
    const name = sheet.attrs.name
    const id = sheet.attrs['r:id']
    const part = id === undefined ? undefined : rels.get(id)?.target.toLowerCase()
    const found = part === undefined ? undefined : byPart.get(part)
    if (name !== undefined && found && (found.used || found.unchecked))
      out.set(name.slice(0, 200), found)
  }
  return out
}

/**
 * Reads an Excel 97-2003 workbook (.xls) from its OLE container's bytes. A BIFF8 FORMULA
 * record always holds a result, so there is no raw scan: a non-calculating writer's
 * placeholder of an empty string, or of a string with no STRING record (which SheetJS
 * drops), shows as the formula or as blank, never as 0 (office.test.ts has both). A writer
 * that stores 0 as its placeholder (as xlwt does) cannot be told from a computed 0, so a
 * formula whose cached result is 0 shows its formula with a caution, and the view says so.
 */
export function extractXls(
  bytes: Uint8Array,
  options: ExtractOptions,
  limits: DocumentLimits,
): DocumentView {
  return readWorkbook(
    'xls',
    (parse) => sheetjs.read(bytes, { ...parse, type: 'array' }),
    options,
    limits,
  )
}

/** Reads CSV or tab-separated text. */
export function extractCsv(
  text: string,
  options: ExtractOptions,
  limits: DocumentLimits,
): DocumentView {
  const select = options.select
  const target =
    select?.range !== undefined
      ? { sheet: 'CSV', range: parseRange(select.range).range }
      : select?.sheet !== undefined
        ? { sheet: 'CSV', range: null }
        : null
  const want = target?.range ?? { r0: 0, c0: 0, r1: limits.office.previewRows - 1, c1: Infinity }
  const keepTo = want.r0 + Math.max(1, limits.office.maxCellsPerCall) - 1
  const tab = /\.tsv$/i.test(options.name ?? '') || /tab-separated/i.test(options.mime ?? '')
  const parsed = parseCsv(text, tab ? '\t' : delimiterOf(text), want.r0, Math.min(want.r1, keepTo))
  const grid: Grid = {
    name: 'CSV',
    used:
      parsed.rows > 0 && parsed.columns > 0
        ? { r0: 0, c0: 0, r1: parsed.rows - 1, c1: parsed.columns - 1 }
        : null,
    cell: (row, column) => parsed.kept.get(row)?.[column] ?? '',
  }
  const view = sheetView('csv', [grid], limits)
  const budget = effectiveBudget(options.budget, limits)
  const section = writeSheet(
    grid,
    target?.range ?? null,
    budget.maxChars,
    limits.office.maxCellsPerCall,
    limits,
    view.warnings,
    !target,
  )
  view.sections.push(section.section)
  view.position.shown = { from: 1, to: 1 }
  return view
}

function readWorkbook(
  kind: DocumentKind,
  parse: (options: XLSX.ParsingOptions) => XLSX.WorkBook,
  options: ExtractOptions,
  limits: DocumentLimits,
  unsaved = new Map<string, UnsavedCells>(),
): DocumentView {
  const base: XLSX.ParsingOptions = {
    dense: true,
    cellFormula: true,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    cellText: true,
    cellDates: false,
    bookVBA: false,
    bookDeps: false,
    bookFiles: false,
    // Kept so a formula cell with no cached value still shows its formula.
    sheetStubs: true,
    WTF: false,
  }
  const run = (extra: XLSX.ParsingOptions): XLSX.WorkBook => {
    try {
      return parse({ ...base, ...extra })
    } catch (error) {
      throw sheetError(error)
    }
  }
  // The sheet names first (the workbook part alone), to find the sheet asked for.
  const names = run({ bookSheets: true }).SheetNames
  if (names.length === 0) throw new DocumentError('malformed', 'The workbook has no sheets.')
  const target = targetOf(options, names)
  const budget = effectiveBudget(options.budget, limits)
  const cells = limits.office.maxCellsPerCall
  const formulas: Formulas = {
    include: options.includeFormulas === true,
    unsaved,
    shownUnsaved: false,
    unchecked: new Set(),
    xls: kind === 'xls',
    zeros: new Set(),
  }

  if (target) {
    const name = target.sheet
    const range = target.range ?? { r0: 0, c0: 0, r1: Infinity, c1: Infinity }
    // Rows to parse: as many as the cell cap allows at this width (at one column when the
    // width is open, as in "5:20", since the used columns are not known yet).
    const rows = Number.isFinite(range.c1)
      ? Math.max(1, Math.floor(cells / Math.min(range.c1 - range.c0 + 1, cells)))
      : cells
    const sheetRows = Math.min(MAX_ROWS, range.r1 + 1, range.r0 + rows)
    const book = run({ sheets: name, sheetRows })
    const grids = gridsOf(book, formulas, limits)
    const view = sheetView(kind, grids, limits)
    const index = grids.findIndex((grid) => grid.name === name)
    const grid = grids[index]
    if (!grid) throw new DocumentError('malformed', `The sheet "${name}" could not be read.`)
    const written = writeSheet(grid, range, budget.maxChars, cells, limits, view.warnings, false)
    view.sections.push(written.section)
    view.position.shown = { from: index + 1, to: index + 1 }
    view.warnings.push(...formulaNotes(formulas))
    return view
  }

  const book = run({ sheetRows: limits.office.previewRows })
  const grids = gridsOf(book, formulas, limits)
  const view = sheetView(kind, grids, limits)
  const total = view.position.total
  const from = Math.max(1, Math.floor(options.select?.from ?? 1))
  if (from > total) {
    throw new DocumentError(
      'out-of-range',
      `Sheet ${String(from)} is past the end; the workbook has ${String(total)} sheets.`,
    )
  }
  let chars = 0
  let used = 0
  let last = from - 1
  for (
    let number = from;
    number <= total && view.sections.length < limits.maxPagesPerCall;
    number++
  ) {
    const grid = grids[number - 1]
    if (!grid) break
    const left = { chars: budget.maxChars - chars, cells: cells - used }
    if (number > from && (left.chars < 200 || left.cells < 1)) break
    const written = writeSheet(
      grid,
      null,
      Math.max(1, left.chars),
      Math.max(1, left.cells),
      limits,
      view.warnings,
      true,
    )
    if (number > from && written.cut) break
    chars += written.section.text.length
    used += written.cells
    view.sections.push(written.section)
    last = number
  }
  view.position.shown = { from, to: last }
  view.position.next = last < total ? last + 1 : null
  view.warnings.push(...formulaNotes(formulas))
  return view
}

const UNSAVED_NOTE =
  'Some formulas have no saved value (shown as "=formula (no saved value)"); recalculate in Excel and save to get values.'

function formulaNotes(formulas: Formulas): string[] {
  const notes = formulas.shownUnsaved ? [UNSAVED_NOTE] : []
  for (const name of formulas.unchecked) {
    notes.push(
      `The sheet "${name}" has too many formulas to check which have saved values; its formulas are shown as formulas, not values.`,
    )
  }
  for (const name of formulas.zeros) {
    notes.push(
      `Some .xls formula results in "${name}" are 0 and may not have been calculated; recalculate in Excel and save as .xlsx to confirm.`,
    )
  }
  return notes
}

/** How formula cells are written: with their text or not, and which have no saved value. */
interface Formulas {
  include: boolean
  /** Sheet name -> formula cells found without a result in the raw XML. */
  unsaved: Map<string, UnsavedCells>
  /** Set once a cell without a saved value is written, for the note. */
  shownUnsaved: boolean
  /** Sheets whose formulas were shown as formulas because not every cell could be checked. */
  unchecked: Set<string>
  /** An .xls workbook, whose formulas' cached 0 may be a placeholder for no result. */
  xls: boolean
  /** Sheets where such a 0 was written, for the note. */
  zeros: Set<string>
}

function sheetError(error: unknown): DocumentError {
  if (error instanceof DocumentError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/password|encrypt/i.test(message)) {
    return new DocumentError(
      'password-protected',
      'The workbook is password-protected. Save a copy without the password and try again.',
    )
  }
  return new DocumentError('malformed', 'The workbook is damaged or in a form that cannot be read.')
}

function sheetView(kind: DocumentKind, grids: Grid[], limits: DocumentLimits): DocumentView {
  const listed = grids.slice(0, limits.office.maxSheets)
  const sheets: SheetInfo[] = listed.map((grid) => ({
    name: grid.name,
    used: grid.used ? a1(grid.used) : null,
    ...(grid.hidden ? { hidden: true } : {}),
  }))
  const view: DocumentView = {
    meta: { kind, mime: MIME[kind], sheets },
    sections: [],
    images: [],
    position: { unit: 'sheet', total: listed.length, shown: { from: 0, to: 0 }, next: null },
    warnings: [],
  }
  if (grids.length > listed.length) {
    view.warnings.push(
      `The workbook has ${String(grids.length)} sheets; only the first ${String(listed.length)} are listed and can be read here.`,
    )
  }
  return view
}

function gridsOf(book: XLSX.WorkBook, formulas: Formulas, limits: DocumentLimits): Grid[] {
  const hidden = book.Workbook?.Sheets ?? []
  return book.SheetNames.slice(0, limits.office.maxSheets).map((name, index) => {
    const sheet = book.Sheets[name] as
      (XLSX.WorkSheet & { '!data'?: XLSX.CellObject[][] }) | undefined
    const ref = (sheet?.['!fullref'] as string | undefined) ?? sheet?.['!ref']
    const missing = formulas.unsaved.get(name.slice(0, 200))
    // OpenDocument cells with no value are dropped by SheetJS, so may lie past its range.
    const used = union(ref ? decodeRange(ref) : null, missing?.used ?? null)
    const data = sheet?.['!data'] ?? []
    return {
      name: name.slice(0, 200),
      used,
      ...(hidden[index]?.Hidden ? { hidden: true } : {}),
      cell: (row: number, column: number) => {
        const cell = data[row]?.[column]
        const text = cellText(cell, formulas, missing?.at(row, column), name.slice(0, 200))
        // A value that could not be checked is not trusted: the formula is shown instead.
        if (!missing?.unchecked || !cell?.f || text.endsWith('(no saved value)')) return text
        formulas.unchecked.add(name.slice(0, 200))
        return `=${cell.f}`
      },
    }
  })
}

function union(a: Range | null, b: Range | null): Range | null {
  if (!a || !b) return a ?? b
  return {
    r0: Math.min(a.r0, b.r0),
    c0: Math.min(a.c0, b.c0),
    r1: Math.max(a.r1, b.r1),
    c1: Math.max(a.c1, b.c1),
  }
}

/**
 * A cell as text. `unsaved` is the formula when the raw XML has one with no stored result
 * ('' when SheetJS read the formula itself); SheetJS's own sign of the same is a stub
 * (`t: 'z'`) that still carries a formula.
 */
function cellText(
  cell: XLSX.CellObject | undefined,
  formulas: Formulas,
  unsaved: string | undefined,
  sheet: string,
): string {
  const stub = !cell || cell.t === 'z' || cell.v === undefined || cell.v === ''
  if ((cell?.f !== undefined && cell.t === 'z') || (unsaved !== undefined && stub)) {
    formulas.shownUnsaved = true
    const formula = cell?.f || unsaved
    return formula ? `=${formula} (no saved value)` : '(formula with no saved value)'
  }
  if (!cell) return ''
  let value =
    cell.w ??
    (cell.v === undefined
      ? ''
      : cell.t === 'b'
        ? cell.v
          ? 'TRUE'
          : 'FALSE'
        : cell.v instanceof Date
          ? cell.v.toISOString()
          : String(cell.v))
  if (formulas.xls && cell.f && cell.t === 'n' && cell.v === 0) {
    formulas.zeros.add(sheet)
    return `${value} (=${cell.f}; may be unsaved)`
  }
  if (cell.f && (formulas.include || value === ''))
    value = value === '' ? `=${cell.f}` : `${value} (=${cell.f})`
  return value
}

/**
 * One sheet as a table: `range` (clipped to the used cells) or, when null, its first rows
 * (`preview`: at most previewRows x previewColumns). At most `cells` cells and `chars`
 * characters; what is left is named in `next`.
 */
function writeSheet(
  grid: Grid,
  range: Range | null,
  chars: number,
  cells: number,
  limits: DocumentLimits,
  warnings: string[],
  preview: boolean,
): { section: DocumentSection; cells: number; cut: boolean } {
  const sheet: SheetPart = { name: grid.name, shown: null, used: grid.used ? a1(grid.used) : null }
  const section: DocumentSection = { title: grid.name, text: '', sheet }
  const used = grid.used
  if (!used) {
    section.text = '(empty sheet)'
    return { section, cells: 0, cut: false }
  }
  const want = range ?? used
  const area: Range = {
    r0: Math.max(want.r0, preview ? used.r0 : 0),
    c0: Math.max(want.c0, preview ? used.c0 : 0),
    r1: Math.min(want.r1, used.r1),
    c1: Math.min(want.c1, used.c1),
  }
  if (area.r0 > area.r1 || area.c0 > area.c1) {
    section.text = `(no cells with content in ${a1(clip(want))})`
    return { section, cells: 0, cut: false }
  }
  let c1 = area.c1
  if (preview) c1 = Math.min(c1, area.c0 + limits.office.previewColumns - 1)
  c1 = Math.min(c1, area.c0 + cells - 1)
  const columns = c1 - area.c0 + 1
  let r1 = Math.min(area.r1, area.r0 + Math.floor(cells / columns) - 1)
  if (preview) r1 = Math.min(r1, area.r0 + limits.office.previewRows - 1)

  const header = `| | ${Array.from({ length: columns }, (_, i) => columnName(area.c0 + i)).join(' | ')} |`
  const rule = `|${' --- |'.repeat(columns + 1)}`
  const lines = [header, rule]
  let length = header.length + rule.length + 1
  let last = area.r0 - 1
  for (let row = area.r0; row <= r1; row++) {
    const values: string[] = []
    for (let column = area.c0; column <= c1; column++)
      values.push(escapeCell(grid.cell(row, column)))
    let line = `| ${String(row + 1)} | ${values.join(' | ')} |`
    if (length + line.length + 1 > chars) {
      if (row > area.r0) break
      line = line.slice(0, Math.max(0, chars - length - 1))
      warnings.push(`Row ${String(row + 1)} of "${grid.name}" was cut to fit the text budget.`)
    }
    lines.push(line)
    length += line.length + 1
    last = row
  }
  section.text = lines.join('\n')
  sheet.shown = a1({ r0: area.r0, c0: area.c0, r1: last, c1 })
  if (last < area.r1) {
    sheet.next = a1({ r0: last + 1, c0: area.c0, r1: area.r1, c1: area.c1 })
  } else if (c1 < area.c1) {
    sheet.next = a1({ r0: area.r0, c0: c1 + 1, r1: area.r1, c1: area.c1 })
  }
  if (!preview && c1 < area.c1 && last < area.r1) {
    warnings.push(
      `Only columns ${columnName(area.c0)}-${columnName(c1)} of "${grid.name}" fit in one call; read the others with a narrower range.`,
    )
  }
  return {
    section,
    cells: (last - area.r0 + 1) * columns,
    cut: last < r1,
  }
}

const clip = (range: Range): Range => ({
  r0: range.r0,
  c0: range.c0,
  r1: Math.min(range.r1, MAX_ROWS - 1),
  c1: Math.min(range.c1, MAX_COLUMNS - 1),
})

/** Which sheet and cells were asked for, or null for the default view. */
function targetOf(
  options: ExtractOptions,
  names: readonly string[],
): { sheet: string; range: Range | null } | null {
  const select = options.select
  if (!select?.sheet && !select?.range) return null
  const parsed = select.range ? parseRange(select.range) : { sheet: undefined, range: null }
  const asked = parsed.sheet ?? select.sheet
  let sheet = names[0] ?? ''
  if (asked !== undefined) {
    const found =
      names.find((name) => name === asked) ??
      names.find((name) => name.toLowerCase() === asked.toLowerCase())
    if (found === undefined) {
      throw new DocumentError(
        'out-of-range',
        `There is no sheet named "${asked.slice(0, 100)}". Sheets: ${names
          .slice(0, 50)
          .map((name) => `"${name}"`)
          .join(', ')}.`,
      )
    }
    sheet = found
  }
  return { sheet, range: parsed.range }
}

/**
 * An A1 reference with an optional sheet: `Sheet1!A1:H200`, `'My sheet'!B2`, `A:C`
 * (whole columns), `5:20` (whole rows), or a sheet name alone (`Sheet1!`).
 */
export function parseRange(text: string): { sheet?: string; range: Range | null } {
  const bad = (): DocumentError =>
    new DocumentError(
      'out-of-range',
      `"${text.slice(0, 100)}" is not a range; use A1 references such as "Sheet1!A1:H200", "B2:D40" or "A:C".`,
    )
  let rest = text.trim()
  let sheet: string | undefined
  const quoted = /^'((?:[^']|'')+)'!/.exec(rest)
  const bang = rest.lastIndexOf('!')
  if (quoted) {
    sheet = (quoted[1] ?? '').replace(/''/g, "'")
    rest = rest.slice(quoted[0].length)
  } else if (bang >= 0) {
    sheet = rest.slice(0, bang)
    rest = rest.slice(bang + 1)
  }
  rest = rest.replace(/\$/g, '').toUpperCase()
  if (!rest) return { ...(sheet ? { sheet } : {}), range: null }
  const part = (ref: string): { r: number | null; c: number | null } | null => {
    const match = /^([A-Z]{0,3})(\d{0,7})$/.exec(ref)
    if (!match || (!match[1] && !match[2])) return null
    const c = match[1] ? columnIndex(match[1]) : null
    const r = match[2] ? Number(match[2]) - 1 : null
    if ((c !== null && c >= MAX_COLUMNS) || (r !== null && (r < 0 || r >= MAX_ROWS))) return null
    return { r, c }
  }
  const [first, second, extra] = rest.split(':')
  if (first === undefined || extra !== undefined) throw bad()
  const a = part(first)
  const b = second === undefined ? a : part(second)
  if (!a || !b) throw bad()
  // A1 or A1:B2 are cells, A:C columns, 3:10 rows; A21:H runs from A21 to the end of column H.
  const openRows = a.r !== null && a.c !== null && b.r === null && b.c !== null
  if (!openRows && ((a.r === null) !== (b.r === null) || (a.c === null) !== (b.c === null))) {
    throw bad()
  }
  const range: Range = {
    r0: a.r ?? 0,
    c0: a.c ?? 0,
    r1: b.r ?? Infinity,
    c1: b.c ?? Infinity,
  }
  if (range.r1 < range.r0 || range.c1 < range.c0) throw bad()
  return { ...(sheet ? { sheet } : {}), range }
}

function decodeRange(ref: string): Range | null {
  try {
    const range = XLSX.utils.decode_range(ref)
    if (![range.s.r, range.s.c, range.e.r, range.e.c].every((n) => Number.isInteger(n) && n >= 0)) {
      return null
    }
    return {
      r0: range.s.r,
      c0: range.s.c,
      r1: Math.min(range.e.r, MAX_ROWS - 1),
      c1: Math.min(range.e.c, MAX_COLUMNS - 1),
    }
  } catch {
    return null
  }
}

export function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

function columnIndex(name: string): number {
  let index = 0
  for (const char of name) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

const a1 = (range: Range): string => {
  const start = `${columnName(range.c0)}${String(range.r0 + 1)}`
  const end = `${columnName(range.c1)}${String(range.r1 + 1)}`
  return start === end ? start : `${start}:${end}`
}

/** The text SheetJS will parse, enough of it to see a DTD: the bytes as UTF-8 or UTF-16. */
function dtdProbe(bytes: Uint8Array): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return decodeXml(bytes)
  }
  // ASCII is enough to find "<!DOCTYPE" and "<!ENTITY"; latin1 never fails to decode.
  return new TextDecoder('latin1').decode(bytes)
}

/** The most common of comma, semicolon and tab outside quotes on the first line. */
function delimiterOf(text: string): string {
  const counts = new Map([
    [',', 0],
    [';', 0],
    ['\t', 0],
  ])
  let quoted = false
  for (let i = 0; i < text.length && i < 65_536; i++) {
    const char = text[i] ?? ''
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === '\n' || char === '\r')) break
    else if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1)
  }
  let best = ','
  for (const [char, count] of counts) if (count > (counts.get(best) ?? 0)) best = char
  return best
}

/**
 * RFC 4180 CSV: quoted fields may hold the delimiter, quotes ("") and line breaks. Only
 * rows `keepFrom`..`keepTo` are kept; all are counted, for the used range.
 */
export function parseCsv(
  text: string,
  delimiter: string,
  keepFrom: number,
  keepTo: number,
): { rows: number; columns: number; kept: Map<number, string[]> } {
  const kept = new Map<number, string[]>()
  let row: string[] = []
  let field = ''
  let quoted = false
  let rows = 0
  let columns = 0
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const endRow = (): void => {
    row.push(field)
    field = ''
    if (row.length > 1 || row[0] !== '') columns = Math.max(columns, row.length)
    if (rows >= keepFrom && rows <= keepTo) kept.set(rows, row)
    rows++
    row = []
  }
  for (; at < text.length; at++) {
    const char = text[at] ?? ''
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          field += '"'
          at++
        } else quoted = false
      } else field += char
    } else if (char === '"' && field === '') {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at++
      endRow()
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) endRow()
  return { rows, columns, kept }
}
