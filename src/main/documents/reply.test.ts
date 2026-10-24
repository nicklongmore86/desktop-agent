import { describe, expect, it } from 'vitest'
import { jpegShell, pngShell } from './fixtures.test-util'
import { DEFAULT_LIMITS, type DocumentLimits } from './limits'
import { checkReply, type ReplyJob } from './reply'
import { DocumentError, type DocumentImage, type DocumentView } from './types'

const job = (options: ReplyJob['options'] = {}, limits: DocumentLimits = DEFAULT_LIMITS) => ({
  id: 7,
  options,
  limits,
})
const png = (width: number, height: number, page = 1): DocumentImage => ({
  bytes: pngShell(width, height),
  mime: 'image/png',
  width,
  height,
  source: { page },
})
const pdfView = (overrides: Partial<DocumentView> = {}): DocumentView => ({
  meta: { kind: 'pdf', mime: 'application/pdf', pageCount: 3 },
  sections: [
    { page: 1, text: 'one' },
    { page: 2, text: '' },
  ],
  images: [png(1212, 1568, 2)],
  position: { unit: 'page', total: 3, shown: { from: 1, to: 2 }, next: 3 },
  warnings: [],
  ...overrides,
})
const reply = (view: unknown, id = 7) => ({ type: 'result', id, view })

/** The reason a reply was refused, or 'accepted'. */
function verdict(raw: unknown, request: ReplyJob = job()): string {
  try {
    checkReply(raw, request)
    return 'accepted'
  } catch (error) {
    if (!(error instanceof DocumentError) || error.code !== 'worker-failed') throw error
    return error.message
      .replace('The document reader returned an invalid result: ', '')
      .replace(/\.$/, '')
  }
}

describe('checkReply', () => {
  it('accepts a well-formed reply and returns a fresh copy', () => {
    const view = pdfView()
    const checked = checkReply(reply(view), job())
    expect(checked).toEqual({ type: 'result', id: 7, view })
    if (checked.type !== 'result') throw new Error('not a result')
    expect(checked.view.images[0]?.bytes.buffer).not.toBe(view.images[0]?.bytes.buffer)
    expect(checked.view).not.toBe(view)
  })

  it('caps images at 20 per call, and at what the request asked for', () => {
    const images = Array.from({ length: 21 }, () => png(100, 100))
    const pages = { position: { unit: 'page', total: 1, shown: { from: 1, to: 1 }, next: null } }
    const one = { meta: { kind: 'pdf', mime: 'application/pdf', pageCount: 1 } }
    const sections = [{ page: 1, text: 'x' }]
    expect(verdict(reply(pdfView({ ...one, ...pages, sections, images } as never)))).toBe(
      'its reply did not match what was asked',
    )
    const three = images.slice(0, 3)
    expect(
      verdict(
        reply(pdfView({ ...one, ...pages, sections, images: three } as never)),
        job({ budget: { maxImages: 2 } }),
      ),
    ).toBe('it returned more images than asked')
  })

  it('caps pages at 50 per call', () => {
    const sections = Array.from({ length: 51 }, (_, i) => ({ page: i + 1, text: '' }))
    const position = { unit: 'page' as const, total: 60, shown: { from: 1, to: 51 }, next: 52 }
    const meta = { kind: 'pdf' as const, mime: 'application/pdf', pageCount: 60 }
    expect(
      verdict(reply(pdfView({ meta, sections: sections.slice(0, 50), images: [], position }))),
    ).toBe('it returned more pages than allowed')
    // 51 sections is also more than the section cap (50 pages + one metadata section).
    expect(
      verdict(
        reply(
          pdfView({ meta, sections: [...sections, { page: 1, text: '' }], images: [], position }),
        ),
      ),
    ).toBe('its reply did not match what was asked')
  })

  it('caps text per section and in total at the request’s budget', () => {
    const request = job({ budget: { maxChars: 100 } })
    const long = 'x'.repeat(100 + 4096 + 1)
    expect(verdict(reply(pdfView({ sections: [{ page: 1, text: long }] })), request)).toBe(
      'its reply did not match what was asked',
    )
    const half = 'x'.repeat(2100)
    expect(
      verdict(
        reply(
          pdfView({
            sections: [
              { page: 1, text: half },
              { page: 2, text: half },
            ],
          }),
        ),
        request,
      ),
    ).toBe('it returned more text than asked')
    // The hard cap holds even when the request asks for more.
    const greedy = job({ budget: { maxChars: 10_000_000 } })
    const huge = 'x'.repeat(DEFAULT_LIMITS.maxCharsPerCall + 4097)
    expect(verdict(reply(pdfView({ sections: [{ page: 1, text: huge }] })), greedy)).toBe(
      'its reply did not match what was asked',
    )
  })

  it('caps image width and height at the long edge asked for', () => {
    for (const [width, height] of [
      [1568, 1569],
      [1569, 1568],
    ] as const) {
      expect(verdict(reply(pdfView({ images: [png(width, height, 2)] })))).toBe(
        'its reply did not match what was asked',
      )
    }
    expect(verdict(reply(pdfView({ images: [png(1568, 1568, 2)] })))).toBe('accepted')
    expect(
      verdict(reply(pdfView({ images: [png(800, 801, 2)] })), job({ budget: { longEdge: 800 } })),
    ).toBe('its reply did not match what was asked')
  })

  it('caps the pixel product', () => {
    const limits = { ...DEFAULT_LIMITS, maxLongEdge: 20_000, maxDecodedPixels: 1_000_000 }
    const request = job({ budget: { longEdge: 2000 } }, limits)
    expect(verdict(reply(pdfView({ images: [png(1500, 1500, 2)] })), request)).toBe(
      'an image is too large',
    )
    expect(verdict(reply(pdfView({ images: [png(1000, 1000, 2)] })), request)).toBe('accepted')
  })

  it('caps encoded image bytes', () => {
    const limits = { ...DEFAULT_LIMITS, maxImageBytes: 64 }
    const padded = new Uint8Array(65)
    padded.set(pngShell(100, 100))
    const image = { ...png(100, 100, 2), bytes: padded }
    expect(verdict(reply(pdfView({ images: [image] })), job({}, limits))).toBe(
      'its reply did not match what was asked',
    )
    expect(
      verdict(
        reply(pdfView({ images: [{ ...image, bytes: padded.subarray(0, 64) }] })),
        job({}, limits),
      ),
    ).toBe('accepted')
  })

  it('refuses an image that is not what it claims', () => {
    const asJpeg = { ...png(100, 100, 2), mime: 'image/jpeg' as const }
    expect(verdict(reply(pdfView({ images: [asJpeg] })))).toBe(
      'an image is not what it claims to be',
    )
    const wrongSize = { ...png(100, 100, 2), width: 99 }
    expect(verdict(reply(pdfView({ images: [wrongSize] })))).toBe(
      'an image is not what it claims to be',
    )
    const jpeg: DocumentImage = {
      bytes: jpegShell(64, 32),
      mime: 'image/jpeg',
      width: 64,
      height: 32,
      source: { page: 2 },
    }
    expect(verdict(reply(pdfView({ images: [jpeg] })))).toBe('accepted')
  })

  it('refuses non-PNG and non-JPEG bytes that carry forged dimensions', () => {
    // PNG's first two bytes, then the claimed width and height where IHDR would hold them.
    const lookalike = new Uint8Array(33)
    lookalike.set([0x89, 0x50])
    new DataView(lookalike.buffer).setUint32(16, 100)
    new DataView(lookalike.buffer).setUint32(20, 100)
    const badType = pngShell(100, 100)
    badType.set([0x49, 0x44, 0x41, 0x54], 12) // 'IDAT' where 'IHDR' belongs
    const badLength = pngShell(100, 100)
    badLength[11] = 12
    const truncated = pngShell(100, 100).subarray(0, 26)
    for (const bytes of [lookalike, badType, badLength, truncated]) {
      expect(verdict(reply(pdfView({ images: [{ ...png(100, 100, 2), bytes }] })))).toBe(
        'an image is not what it claims to be',
      )
    }
    // SOI alone, with no frame header after it.
    const soiOnly = new Uint8Array(32)
    soiOnly.set([0xff, 0xd8, 0xff, 0xd9])
    const jpeg: DocumentImage = {
      bytes: soiOnly,
      mime: 'image/jpeg',
      width: 64,
      height: 32,
      source: { page: 2 },
    }
    expect(verdict(reply(pdfView({ images: [jpeg] })))).toBe('an image is not what it claims to be')
  })

  it('accepts 20 images near the per-image byte limit', () => {
    const big = new Uint8Array(DEFAULT_LIMITS.maxImageBytes)
    big.set(pngShell(100, 100))
    const images = Array.from({ length: 20 }, () => ({ ...png(100, 100, 1), bytes: big }))
    const pages = { position: { unit: 'page', total: 1, shown: { from: 1, to: 1 }, next: null } }
    const one = { meta: { kind: 'pdf', mime: 'application/pdf', pageCount: 1 } }
    const sections = [{ page: 1, text: 'x' }]
    expect(verdict(reply(pdfView({ ...one, ...pages, sections, images } as never)))).toBe(
      'accepted',
    )
  })

  it('refuses bytes that are not a Uint8Array', () => {
    const image = png(100, 100, 2)
    for (const bytes of [Array.from(image.bytes), image.bytes.buffer, 'abc', { length: 10 }]) {
      expect(verdict(reply(pdfView({ images: [{ ...image, bytes } as never] })))).toBe(
        'its reply did not match what was asked',
      )
    }
  })

  it('refuses pages outside the range shown, and an inconsistent position', () => {
    expect(verdict(reply(pdfView({ sections: [{ page: 3, text: 'x' }] })))).toBe(
      'it returned a page it did not show',
    )
    expect(verdict(reply(pdfView({ images: [png(100, 100, 3)] })))).toBe(
      'it returned a page it did not show',
    )
    const position = { unit: 'page' as const, total: 3, shown: { from: 1, to: 2 }, next: 2 }
    expect(verdict(reply(pdfView({ position })))).toBe('its position is inconsistent')
    const past = { unit: 'page' as const, total: 3, shown: { from: 1, to: 4 }, next: null }
    expect(verdict(reply(pdfView({ position: past })))).toBe('its position is inconsistent')
    expect(
      verdict(reply(pdfView({ meta: { kind: 'pdf', mime: 'application/pdf', pageCount: 9 } }))),
    ).toBe('its page count is inconsistent')
  })

  it('refuses unknown keys, the wrong job id and junk', () => {
    expect(verdict(reply({ ...pdfView(), extra: 1 }))).toBe(
      'its reply did not match what was asked',
    )
    expect(verdict(reply(pdfView(), 8))).toBe('its reply did not match what was asked')
    for (const junk of [null, 'result', 42, [], { type: 'result' }, { type: 'other', id: 7 }]) {
      expect(verdict(junk)).toBe('its reply did not match what was asked')
    }
  })

  it('maps error replies to known codes, bounded', () => {
    expect(
      checkReply({ type: 'error', id: 7, code: 'password-protected', message: 'locked' }, job()),
    ).toEqual({
      type: 'error',
      id: 7,
      code: 'password-protected',
      message: 'locked',
    })
    expect(checkReply({ type: 'error', id: 7, code: 'timeout', message: '' }, job())).toMatchObject(
      {
        code: 'worker-failed',
        message: 'The document could not be read.',
      },
    )
    expect(verdict({ type: 'error', id: 7, code: 'malformed', message: 'x'.repeat(1001) })).toBe(
      'its reply did not match what was asked',
    )
  })
})

describe('checkReply: Office shapes', () => {
  const sheetView = (overrides: Partial<DocumentView> = {}): DocumentView => ({
    meta: {
      kind: 'xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sheets: [
        { name: 'Sales', used: 'A1:D60' },
        { name: 'Notes', used: null, hidden: true },
      ],
    },
    sections: [
      {
        title: 'Sales',
        text: '| | A |',
        sheet: { name: 'Sales', shown: 'A1:D20', used: 'A1:D60', next: 'A21:D60' },
      },
      { title: 'Notes', text: '(empty sheet)', sheet: { name: 'Notes', shown: null, used: null } },
    ],
    images: [],
    position: { unit: 'sheet', total: 2, shown: { from: 1, to: 2 }, next: null },
    warnings: [],
    ...overrides,
  })

  it('accepts sheets, slides and character positions', () => {
    expect(verdict(reply(sheetView()))).toBe('accepted')
    const slides: DocumentView = {
      meta: { kind: 'pptx', mime: 'x', pageCount: 3 },
      sections: [{ page: 2, title: 'Hi', text: '# Hi' }],
      images: [],
      position: { unit: 'slide', total: 3, shown: { from: 2, to: 2 }, next: 3 },
      warnings: [],
    }
    expect(verdict(reply(slides))).toBe('accepted')
    const text: DocumentView = {
      meta: { kind: 'docx', mime: 'x' },
      sections: [{ text: 'abc' }],
      images: [],
      position: { unit: 'char', total: 10, shown: { from: 1, to: 3 }, next: 4 },
      warnings: [],
    }
    expect(verdict(reply(text))).toBe('accepted')
  })

  it('refuses ranges that are not A1 references, and over-long sheet names', () => {
    const bad = (sheet: Record<string, unknown>) =>
      verdict(reply(sheetView({ sections: [{ title: 'Sales', text: '', sheet } as never] })))
    expect(bad({ name: 'Sales', shown: 'A1:D20', used: 'A1:D60', next: '=HYPERLINK()' })).toBe(
      'its reply did not match what was asked',
    )
    expect(bad({ name: 'Sales', shown: 'A0', used: null })).toBe(
      'its reply did not match what was asked',
    )
    expect(bad({ name: 'x'.repeat(201), shown: null, used: null })).toBe(
      'its reply did not match what was asked',
    )
    expect(bad({ name: 'Sales', shown: null, used: null, extra: 1 })).toBe(
      'its reply did not match what was asked',
    )
  })

  it('refuses a sheet list that does not match the position, or too many sheets', () => {
    expect(
      verdict(
        reply(
          sheetView({ position: { unit: 'sheet', total: 3, shown: { from: 1, to: 2 }, next: 3 } }),
        ),
      ),
    ).toBe('its sheet list is inconsistent')
    const many = Array.from({ length: DEFAULT_LIMITS.office.maxSheets + 1 }, (_, i) => ({
      name: `S${String(i)}`,
      used: null,
    }))
    expect(verdict(reply(sheetView({ meta: { kind: 'xlsx', mime: 'x', sheets: many } })))).toBe(
      'its reply did not match what was asked',
    )
    // More sections than sheets shown.
    const one = sheetView()
    expect(
      verdict(
        reply({
          ...one,
          position: { unit: 'sheet', total: 2, shown: { from: 1, to: 1 }, next: 2 },
        }),
      ),
    ).toBe('it returned a sheet it did not show')
  })

  it('bounds the cells a section claims to show by the per-call cap, whatever its text', () => {
    const shows = (shown: string, used = 'A1:XFD1048576', limits = DEFAULT_LIMITS) =>
      verdict(
        reply(
          sheetView({
            meta: { kind: 'xlsx', mime: 'x', sheets: [{ name: 'Sales', used }] },
            sections: [{ title: 'Sales', text: 'x', sheet: { name: 'Sales', shown, used } }],
            position: { unit: 'sheet', total: 1, shown: { from: 1, to: 1 }, next: null },
          }),
        ),
        job({}, limits),
      )
    // 10,000 cells (the default cap) exactly, and one row more.
    expect(DEFAULT_LIMITS.office.maxCellsPerCall).toBe(10_000)
    expect(shows('A1:J1000')).toBe('accepted')
    expect(shows('A1:J1001')).toBe('it returned more cells than allowed')
    expect(shows('A1:XFD1048576')).toBe('it returned more cells than allowed')
    const small = { ...DEFAULT_LIMITS, office: { ...DEFAULT_LIMITS.office, maxCellsPerCall: 40 } }
    expect(shows('A1:H5', 'A1:H100', small)).toBe('accepted')
    expect(shows('A1:H6', 'A1:H100', small)).toBe('it returned more cells than allowed')
    // Across sheets: two sections at the cap each are twice the cap.
    const two = sheetView({
      sections: [
        {
          title: 'Sales',
          text: 'x',
          sheet: { name: 'Sales', shown: 'A1:J1000', used: 'A1:J2000' },
        },
        { title: 'Notes', text: 'x', sheet: { name: 'Notes', shown: 'A1', used: 'A1' } },
      ],
    })
    expect(verdict(reply(two))).toBe('it returned more cells than allowed')
    // Shown cells outside the used range.
    expect(shows('B2:C3', 'A1:B2')).toBe('it showed cells outside the sheet')
  })

  it('refuses ranges past Excel’s 1,048,576 rows and 16,384 columns', () => {
    const at = (sheet: Record<string, unknown>, used: string | null = 'A1:D60') =>
      verdict(
        reply(
          sheetView({
            meta: { kind: 'xlsx', mime: 'x', sheets: [{ name: 'Sales', used }] },
            sections: [{ title: 'Sales', text: 'x', sheet } as never],
            position: { unit: 'sheet', total: 1, shown: { from: 1, to: 1 }, next: null },
          }),
        ),
      )
    const sheet = { name: 'Sales', shown: 'A1:D20', used: 'A1:D60' }
    expect(at({ ...sheet, next: 'A21:XFD1048576' })).toBe('accepted')
    expect(at({ ...sheet, next: 'A21:XFE60' })).toBe('a range is outside what a sheet can hold')
    expect(at({ ...sheet, next: 'A21:D1048577' })).toBe('a range is outside what a sheet can hold')
    expect(at({ ...sheet, next: 'D21:A60' })).toBe('a range is outside what a sheet can hold')
    expect(at({ ...sheet, used: 'A1:ZZZ9999999' })).toBe('a range is outside what a sheet can hold')
    expect(at(sheet, 'A1:D9999999')).toBe('a range is outside what a sheet can hold')
  })

  it('refuses sheets on a document that is not a workbook', () => {
    const view = pdfView({
      sections: [{ page: 1, text: 'x', sheet: { name: 'S', shown: null, used: null } }],
      images: [],
      position: { unit: 'page', total: 3, shown: { from: 1, to: 1 }, next: 2 },
    })
    expect(verdict(reply(view))).toBe('it returned sheets for a document that has none')
  })

  it('refuses slides outside the range shown, and more than 50', () => {
    const view: DocumentView = {
      meta: { kind: 'pptx', mime: 'x', pageCount: 80 },
      sections: [{ page: 9, text: '' }],
      images: [],
      position: { unit: 'slide', total: 80, shown: { from: 1, to: 2 }, next: 3 },
      warnings: [],
    }
    expect(verdict(reply(view))).toBe('it returned a page it did not show')
    expect(
      verdict(
        reply({
          ...view,
          sections: [],
          position: { unit: 'slide', total: 80, shown: { from: 1, to: 51 }, next: 52 },
        }),
      ),
    ).toBe('it returned more pages than allowed')
  })
})
