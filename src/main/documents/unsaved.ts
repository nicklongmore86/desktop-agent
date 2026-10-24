import { decodeEntities } from './xml'

/**
 * Formula cells saved without a result, found in a sheet's raw XML. A workbook written
 * by a program that does not calculate (openpyxl, many exporters) stores `<c><f>…</f></c>`
 * with no `<v>`; SheetJS reads some of these as 0 or an empty string and drops others
 * (OpenDocument cells with a formula but no value) altogether. The table writer uses
 * these to show the formula and say there is no value, never a number that was not stored.
 *
 * Cells are never expanded one by one: each tag adds at most one run of columns to a band
 * of rows (an OpenDocument cell repeated over rows and columns is one rectangle), equal
 * bands next to each other merge, and a lookup is two binary searches. So the work and
 * memory are linear in the part's length, whatever its repeat attributes claim. Past
 * MAX_RUNS runs in a workbook, or if a part lists cells out of order, the sheet is marked
 * `unchecked` and the writer shows its formulas as formulas rather than trust any value.
 */

export interface UnsavedCells {
  /** The formula of a cell saved without a result ('' when SheetJS has it); else undefined. */
  at: (row: number, column: number) => string | undefined
  used: { r0: number; c0: number; r1: number; c1: number } | null
  /** Set when not every cell could be checked: no value of this sheet's formulas is trusted. */
  unchecked: boolean
}

export const MAX_ROWS = 1_048_576
export const MAX_COLUMNS = 16_384
export const MAX_RUNS = 1_000_000

/** A shared count of recorded runs, so one workbook's sheets together stay under `max`. */
export interface Recorder {
  runs: number
  max?: number
}

/** Bands of rows, each with sorted, disjoint runs of columns; built in reading order. */
function builder(recorder: Recorder): {
  out: UnsavedCells
  band: (r0: number, r1: number) => void
  add: (c0: number, c1: number, formula: string) => void
  end: () => void
} {
  const r0s: number[] = []
  const r1s: number[] = []
  const starts: number[] = []
  const c0s: number[] = []
  const c1s: number[] = []
  const texts: string[] = []
  let open = false
  const max = recorder.max ?? MAX_RUNS
  const out: UnsavedCells = { used: null, unchecked: false, at: () => undefined }
  const count = (): boolean => {
    if (recorder.runs >= max) {
      out.unchecked = true
      return false
    }
    recorder.runs++
    return true
  }
  const end = (): void => {
    if (!open) return
    open = false
    const last = r0s.length - 1
    const start = starts[last] ?? 0
    const length = c0s.length - start
    if (length === 0) {
      recorder.runs--
      r0s.pop()
      r1s.pop()
      starts.pop()
      return
    }
    // The same runs as the band just above: one taller band.
    const before = last - 1
    const prior = starts[before] ?? 0
    if (before < 0 || (r1s[before] ?? 0) + 1 !== r0s[last] || start - prior !== length) return
    for (let i = 0; i < length; i++) {
      if (
        c0s[prior + i] !== c0s[start + i] ||
        c1s[prior + i] !== c1s[start + i] ||
        texts[prior + i] !== texts[start + i]
      )
        return
    }
    r1s[before] = r1s[last] ?? 0
    recorder.runs -= 1 + length
    r0s.pop()
    r1s.pop()
    starts.pop()
    c0s.length = c1s.length = texts.length = start
  }
  const band = (r0: number, r1: number): void => {
    end()
    if (out.unchecked || r0 < 0 || r0 >= MAX_ROWS) return
    if (r0 <= (r1s[r1s.length - 1] ?? -1)) {
      out.unchecked = true
      return
    }
    if (!count()) return
    r0s.push(r0)
    r1s.push(Math.min(r1, MAX_ROWS - 1))
    starts.push(c0s.length)
    open = true
  }
  const add = (c0: number, c1: number, formula: string): void => {
    if (!open || out.unchecked || c0 < 0 || c0 >= MAX_COLUMNS) return
    c1 = Math.min(c1, MAX_COLUMNS - 1)
    const last = c0s.length - 1
    const start = starts[starts.length - 1] ?? 0
    if (last >= start) {
      const prior = c1s[last] ?? 0
      if (c0 <= prior) {
        out.unchecked = true
        return
      }
      if (c0 === prior + 1 && texts[last] === formula) {
        c1s[last] = c1
        widen(c0, c1)
        return
      }
    }
    if (!count()) return
    c0s.push(c0)
    c1s.push(c1)
    texts.push(formula)
    widen(c0, c1)
  }
  const widen = (c0: number, c1: number): void => {
    const r0 = r0s[r0s.length - 1] ?? 0
    const r1 = r1s[r1s.length - 1] ?? 0
    const used = out.used
    if (!used) {
      out.used = { r0, c0, r1, c1 }
      return
    }
    used.r0 = Math.min(used.r0, r0)
    used.c0 = Math.min(used.c0, c0)
    used.r1 = Math.max(used.r1, r1)
    used.c1 = Math.max(used.c1, c1)
  }
  out.at = (row, column) => {
    const b = below(r0s, row, 0, r0s.length)
    if (b < 0 || row > (r1s[b] ?? -1)) return undefined
    const start = starts[b] ?? 0
    const r = below(c0s, column, start, starts[b + 1] ?? c0s.length)
    if (r < 0 || column > (c1s[r] ?? -1)) return undefined
    return texts[r]
  }
  return { out, band, add, end }
}

/** The last index in [from, to) of a sorted list whose value is at most `value`; -1 if none. */
function below(list: number[], value: number, from: number, to: number): number {
  let lo = from
  let hi = to
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid] ?? 0) <= value) lo = mid + 1
    else hi = mid
  }
  return lo - 1 >= from ? lo - 1 : -1
}

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
  const sheet = builder(recorder)
  let row = -1
  let column = -1
  let band = -1
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
        if (open && formula && !value) {
          if (band !== row) sheet.band(row, row)
          band = row
          sheet.add(column, column, '')
        }
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
  sheet.end()
  return sheet.out
}

/** An OpenDocument content part: per table, cells with a formula and no value. */
export function unsavedOds(text: string, recorder: Recorder): Map<string, UnsavedCells> {
  const out = new Map<string, UnsavedCells>()
  let sheet: ReturnType<typeof builder> | undefined
  let depth = 0
  let row = 0
  let column = 0
  // Repeats are clamped to the sheet; positions past it are never recorded.
  const repeat = (attrs: string, local: string, max: number): number => {
    const n = Number(attribute(attrs, local) ?? 1)
    return Number.isInteger(n) && n > 0 ? Math.min(n, max) : 1
  }
  for (const [, close, name, rest = ''] of text.matchAll(ODS_TAGS)) {
    const selfClosing = rest.endsWith('/')
    if (name === 'table') {
      // Tables inside a cell (sub-tables) are not sheets; only the outermost is followed.
      if (close) {
        depth = Math.max(0, depth - 1)
        if (depth === 0) {
          sheet?.end()
          sheet = undefined
        }
        continue
      }
      if (selfClosing) continue
      depth++
      if (depth > 1) continue
      const title = attribute(rest, 'name') ?? ''
      // A second table of the same name is not read the same way by SheetJS: check neither.
      const twin = out.get(title)
      sheet = builder(recorder)
      if (twin) twin.unchecked = sheet.out.unchecked = true
      else out.set(title, sheet.out)
      row = 0
      continue
    }
    if (depth !== 1 || !sheet) continue
    if (name === 'table-row') {
      if (close) continue
      const rows = repeat(rest, 'number-rows-repeated', MAX_ROWS)
      sheet.band(row, row + rows - 1)
      row = Math.min(row + rows, MAX_ROWS)
      column = 0
      if (selfClosing) sheet.end()
      continue
    }
    if (close) continue
    const columns = repeat(rest, 'number-columns-repeated', MAX_COLUMNS)
    const formula = attribute(rest, 'formula')
    if (formula !== undefined && !hasValue(rest)) {
      sheet.add(column, column + columns - 1, odsFormula(formula))
    }
    column = Math.min(column + columns, MAX_COLUMNS)
  }
  sheet?.end()
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
