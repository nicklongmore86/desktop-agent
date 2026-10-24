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
