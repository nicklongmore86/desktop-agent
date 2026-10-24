import { describe, expect, it } from 'vitest'
import { MAX_COLUMNS, MAX_ROWS, unsavedOds, unsavedXlsx } from './unsaved'

/**
 * The raw-XML scan for formulas saved without a value, on its own: lookups against the
 * cells as written, repeats that never expand, and the fail-safe when it cannot vouch.
 */

const xlsx = (rows: string): string => `<worksheet><sheetData>${rows}</sheetData></worksheet>`
const ods = (rows: string): string => `<table:table table:name="S">${rows}</table:table>`

describe('unsaved formulas', () => {
  it('answers every cell as the XML has it, rows and columns in runs', () => {
    // Unsaved: A1, B1, B2 (a cached value at A2 and a plain value at C2), then A4. C1's empty
    // <v/> is SheetJS's to see (it reads it as a stub).
    const found = unsavedXlsx(
      xlsx(
        '<row r="1"><c r="A1"><f>1</f></c><c r="B1"><f>2</f></c><c r="C1"><f>3</f><v/></c></row>' +
          '<row r="2"><c r="A2"><f>4</f><v>0</v></c><c r="B2"><f>5</f></c><c r="C2"><v>1</v></c></row>' +
          '<row r="4"><c r="A4"><f>6</f></c></row>',
      ),
      { runs: 0 },
    )
    const unsaved = new Set(['0,0', '0,1', '1,1', '3,0'])
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 5; c++) {
        expect(found.at(r, c), `${String(r)},${String(c)}`).toBe(
          unsaved.has(`${String(r)},${String(c)}`) ? '' : undefined,
        )
      }
    }
    expect(found.used).toEqual({ r0: 0, c0: 0, r1: 3, c1: 1 })
    expect(found.unchecked).toBe(false)
  })

  it('keeps a filled-down column as one band', () => {
    const recorder = { runs: 0 }
    let rows = ''
    for (let r = 1; r <= 1000; r++)
      rows += `<row r="${String(r)}"><c r="B${String(r)}"><f>1</f></c></row>`
    const found = unsavedXlsx(xlsx(rows), recorder)
    expect(recorder.runs).toBe(2)
    expect(found.at(999, 1)).toBe('')
    expect(found.at(1000, 1)).toBeUndefined()
    expect(found.at(500, 0)).toBeUndefined()
  })

  it('records an OpenDocument repeat as one rectangle, clamped to the sheet', () => {
    const recorder = { runs: 0 }
    const row =
      '<table:table-row table:number-rows-repeated="99999999"><table:table-cell table:number-columns-repeated="2"/>' +
      '<table:table-cell table:formula="of:=[.A1]" table:number-columns-repeated="99999999"/></table:table-row>'
    const sheets = unsavedOds(ods(row.repeat(100)), recorder)
    const found = sheets.get('S')
    expect(recorder.runs).toBe(2)
    expect(found?.used).toEqual({ r0: 0, c0: 2, r1: MAX_ROWS - 1, c1: MAX_COLUMNS - 1 })
    expect(found?.at(MAX_ROWS - 1, MAX_COLUMNS - 1)).toBe('A1')
    expect(found?.at(0, 1)).toBeUndefined()
    expect(found?.unchecked).toBe(false)
  })

  it('marks a sheet unchecked past the cap or when cells go backwards', () => {
    const capped = unsavedXlsx(
      xlsx('<row r="1"><c r="A1"><f>1</f></c><c r="C1"><f>1</f></c><c r="E1"><f>1</f></c></row>'),
      { runs: 0, max: 3 },
    )
    expect(capped.unchecked).toBe(true)
    // What was recorded before the cap still counts.
    expect(capped.at(0, 0)).toBe('')
    expect(capped.at(0, 2)).toBe('')

    const backwards = unsavedXlsx(
      xlsx('<row r="1"><c r="C1"><f>1</f></c><c r="A1"><f>1</f></c></row>'),
      {
        runs: 0,
      },
    )
    expect(backwards.unchecked).toBe(true)

    // Two tables with one name: neither is vouched for.
    const twins = unsavedOds(ods('') + ods(''), { runs: 0 })
    expect(twins.get('S')?.unchecked).toBe(true)
  })
})
