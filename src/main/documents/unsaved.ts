import { decodeEntities } from './xml'

/**
 * Formula cells saved without a result, found in a sheet's raw XML. A workbook written
 * by a program that does not calculate (openpyxl, many exporters) stores `<c><f>…</f></c>`
 * with no `<v>`; SheetJS reads some of these as 0 or an empty string and drops others
 * (OpenDocument cells with a formula but no value) altogether. The table writer uses
 * these to show the formula and say there is no value, never a number that was not stored.
 *
 * The scan is a single pass over the tags, linear in the part's length; at most
 * MAX_RECORDED cells are kept per workbook (any past that are left as SheetJS reads them).
 */

export interface UnsavedCells {
  /** row * MAX_COLUMNS + column -> the formula's text ('' when SheetJS has it). */
  cells: Map<number, string>
  used: { r0: number; c0: number; r1: number; c1: number }
}

export const MAX_ROWS = 1_048_576
export const MAX_COLUMNS = 16_384
const MAX_RECORDED = 100_000

export const cellKey = (row: number, column: number): number => row * MAX_COLUMNS + column

/** A shared count of recorded cells, so one workbook's sheets together stay under the cap. */
export interface Recorder {
  count: number
}

function record(
  into: UnsavedCells | undefined,
  recorder: Recorder,
  row: number,
  column: number,
  formula: string,
): void {
  if (!into || recorder.count >= MAX_RECORDED) return
  if (row < 0 || column < 0 || row >= MAX_ROWS || column >= MAX_COLUMNS) return
  into.cells.set(cellKey(row, column), formula)
  recorder.count++
  const used = into.used
  if (into.cells.size === 1) {
    used.r0 = used.r1 = row
    used.c0 = used.c1 = column
    return
  }
  used.r0 = Math.min(used.r0, row)
  used.c0 = Math.min(used.c0, column)
  used.r1 = Math.max(used.r1, row)
  used.c1 = Math.max(used.c1, column)
}

const empty = (): UnsavedCells => ({ cells: new Map(), used: { r0: 0, c0: 0, r1: 0, c1: 0 } })

/** An attribute's value by local name (any prefix), decoded; undefined when absent. */
function attribute(attrs: string, local: string): string | undefined {
  let pattern = ATTRIBUTES.get(local)
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${local}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
    ATTRIBUTES.set(local, pattern)
  }
  const match = pattern.exec(attrs)
  if (!match) return undefined
  return decodeEntities(match[1] ?? match[2] ?? '')
}
const ATTRIBUTES = new Map<string, RegExp>()

/** One tag: whether it closes, its local name, and what follows the name (ending in / when empty). */
const tags = (names: string): RegExp =>
  new RegExp(
    `<(\\/?)(?:[A-Za-z_][\\w.-]*:)?(${names})(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`,
    'g',
  )
const XLSX_TAGS = tags('row|c|f|v')
const ODS_TAGS = tags('table|table-row|table-cell|covered-table-cell')

/** A SpreadsheetML worksheet part: cells with an `<f>` and no `<v>`. */
export function unsavedXlsx(text: string, recorder: Recorder): UnsavedCells {
  const out = empty()
  let row = -1
  let column = -1
  let open = false
  let formula = false
  let value = false
  for (const [, close, name, rest = ''] of text.matchAll(XLSX_TAGS)) {
    if (name === 'row') {
      if (close) continue
      const r = Number(attribute(rest, 'r'))
      row = Number.isInteger(r) && r > 0 ? r - 1 : row + 1
      column = -1
    } else if (name === 'c') {
      if (close) {
        if (open && formula && !value) record(out, recorder, row, column, '')
        open = false
        continue
      }
      const ref = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(attribute(rest, 'r') ?? '')
      if (ref) {
        column = columnIndex((ref[1] ?? '').toUpperCase())
        row = Number(ref[2]) - 1
      } else column++
      open = !rest.endsWith('/')
      formula = false
      value = false
    } else if (open && !close) {
      if (name === 'f') formula = true
      else value = true
    }
  }
  return out
}

/** An OpenDocument content part: per table, cells with a formula and no value. */
export function unsavedOds(text: string, recorder: Recorder): Map<string, UnsavedCells> {
  const out = new Map<string, UnsavedCells>()
  let sheet: UnsavedCells | undefined
  let depth = 0
  let row = 0
  let rows = 1
  let column = 0
  const repeat = (attrs: string, local: string): number => {
    const n = Number(attribute(attrs, local) ?? 1)
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_ROWS) : 1
  }
  for (const [, close, name, rest = ''] of text.matchAll(ODS_TAGS)) {
    const selfClosing = rest.endsWith('/')
    if (name === 'table') {
      // Tables inside a cell (sub-tables) are not sheets; only the outermost is followed.
      if (close) {
        depth = Math.max(0, depth - 1)
        if (depth === 0) sheet = undefined
        continue
      }
      if (selfClosing) continue
      depth++
      if (depth > 1) continue
      const title = attribute(rest, 'name') ?? ''
      sheet = out.get(title) ?? empty()
      out.set(title, sheet)
      row = 0
      rows = 1
      continue
    }
    if (depth !== 1) continue
    if (name === 'table-row') {
      if (close) {
        row += rows
        continue
      }
      rows = repeat(rest, 'number-rows-repeated')
      column = 0
      if (selfClosing) row += rows
      continue
    }
    if (close) continue
    const columns = repeat(rest, 'number-columns-repeated')
    const formula = attribute(rest, 'formula')
    if (formula !== undefined && !hasValue(rest)) {
      const text = odsFormula(formula)
      for (let r = row; r < row + rows && r < MAX_ROWS; r++) {
        for (let c = column; c < column + columns && c < MAX_COLUMNS; c++) {
          if (recorder.count >= MAX_RECORDED) break
          record(sheet, recorder, r, c, text)
        }
      }
    }
    column += columns
  }
  return out
}
/** Whether an OpenDocument cell stores a result for its formula. */
function hasValue(attrs: string): boolean {
  switch (attribute(attrs, 'value-type')) {
    case undefined:
      return false
    case 'date':
      return attribute(attrs, 'date-value') !== undefined
    case 'time':
      return attribute(attrs, 'time-value') !== undefined
    case 'boolean':
      return attribute(attrs, 'boolean-value') !== undefined
    case 'string':
      return true
    default:
      return attribute(attrs, 'value') !== undefined
  }
}

/** OpenFormula as Excel writes it, for display: `of:=SUM([.A1:.A3])` -> `SUM(A1:A3)`. */
export function odsFormula(text: string): string {
  return text
    .replace(/^(?:[a-z]+:)?=?/i, '')
    .replace(/\[([^\]]*)\]/g, (_whole, inner: string) =>
      inner
        .split(':')
        .map((part) => {
          const dot = part.lastIndexOf('.')
          const sheet = part
            .slice(0, Math.max(0, dot))
            .replace(/^\$/, '')
            .replace(/^'(.*)'$/, '$1')
          const ref = part.slice(dot + 1)
          return sheet ? `${sheet}!${ref}` : ref
        })
        .join(':'),
    )
    .replace(/"[^"]*"|;/g, (match) => (match === ';' ? ',' : match))
}

function columnIndex(name: string): number {
  let index = 0
  for (const char of name) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}
