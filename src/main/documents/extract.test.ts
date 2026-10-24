import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { extractDocument, type ExtractEnv } from './extract'
import { jpegShell, makeExif, makePdf, makeZip, pngShell, withExif } from './fixtures.test-util'
import { DEFAULT_LIMITS } from './limits'
import { DocumentError, type ExtractOptions } from './types'

/**
 * The dispatcher and the PDF reader with the real PDFium WASM (Node build), and stand-in
 * codecs: the browser's createImageBitmap/OffscreenCanvas run in the e2e tests. Every
 * case here is also a "refuses without hanging" check: Vitest fails anything over 5 s.
 */

let pdfium: WrappedPdfiumModule
const rasters: { width: number; height: number; blue: number }[] = []

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasm = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
  pdfium = await init({
    wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length),
  })
  pdfium.PDFiumExt_Init()
})

function env(): ExtractEnv & { decodeImage: ReturnType<typeof vi.fn> } {
  rasters.length = 0
  return {
    pdfium: () => Promise.resolve(pdfium),
    encode: (rgba, width, height) => {
      let blue = 0
      for (let i = 0; i < rgba.length; i += 4) {
        if ((rgba[i + 2] ?? 0) > 150 && (rgba[i] ?? 0) < 100) blue++
      }
      rasters.push({ width, height, blue })
      return Promise.resolve({
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'image/png' as const,
        width,
        height,
      })
    },
    decodeImage: vi.fn(() =>
      Promise.resolve({
        bytes: new Uint8Array([4]),
        mime: 'image/jpeg' as const,
        width: 2,
        height: 1,
      }),
    ),
  }
}

const read = (bytes: Uint8Array, options: ExtractOptions = {}, e = env()) =>
  extractDocument(bytes, options, e)

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof DocumentError ? error.code : `unexpected: ${String(error)}`
  }
  return 'resolved'
}

const report = makePdf([
  { text: ['Quarterly report', 'Revenue rose 12 percent across all regions this quarter.'] },
  { drawing: true },
  { text: ['Appendix A', 'Methodology and sources for every figure in this report.'] },
])

describe('PDF', () => {
  it('reads text per page and renders pages with little or no text', async () => {
    const view = await read(report, { name: 'report.pdf' })
    expect(view.meta).toMatchObject({ kind: 'pdf', pageCount: 3, name: 'report.pdf' })
    expect(view.sections.map((s) => s.page)).toEqual([1, 2, 3])
    expect(view.sections[0]?.text).toBe(
      'Quarterly report\nRevenue rose 12 percent across all regions this quarter.',
    )
    // Only the drawing (page 2) has no text, so only it is rendered.
    expect(view.images).toHaveLength(1)
    expect(view.images[0]).toMatchObject({ width: 1212, height: 1568, source: { page: 2 } })
    expect(rasters[0]?.blue).toBeGreaterThan(1000)
    expect(view.position).toEqual({ unit: 'page', total: 3, shown: { from: 1, to: 3 }, next: null })
  })

  it('reads a page range and says where to continue', async () => {
    const view = await read(report, { select: { from: 2, to: 2 }, view: 'text' })
    expect(view.sections.map((s) => s.page)).toEqual([2])
    expect(view.images).toHaveLength(0)
    expect(view.position).toMatchObject({ shown: { from: 2, to: 2 }, next: 3 })
  })

  it('stops at a page boundary when the text budget runs out', async () => {
    const view = await read(report, { budget: { maxChars: 80 }, view: 'text' })
    expect(view.sections.map((s) => s.page)).toEqual([1, 2])
    expect(view.position.next).toBe(3)
    const tight = await read(report, { budget: { maxChars: 10 }, view: 'text' })
    expect(tight.sections[0]?.text).toBe('Quarterly ')
    expect(tight.warnings).toContain('Page 1 was cut to 10 characters.')
  })

  it("renders every page in 'images' view, up to the image budget", async () => {
    const view = await read(report, { view: 'images', budget: { maxImages: 2, longEdge: 800 } })
    expect(view.images.map((i) => i.source.page)).toEqual([1, 2])
    expect(view.images.every((i) => Math.max(i.width, i.height) === 800)).toBe(true)
    expect(view.position.next).toBe(3)
  })

  it('re-renders a region at a higher resolution, with the text inside it', async () => {
    const region = { page: 2, x: 0.15, y: 0.2, width: 0.25, height: 0.25 }
    const view = await read(report, { select: { region } })
    expect(view.images).toHaveLength(1)
    const [image] = view.images
    expect(image?.source).toEqual({ page: 2, region })
    // A quarter of the page each way, scaled so its long edge is 1568 px: ~4x a full-page render.
    expect(image).toMatchObject({ width: 1212, height: 1568 })
    expect(rasters[0]?.blue).toBeGreaterThan(20_000)

    const text = await read(report, {
      select: { region: { page: 1, x: 0, y: 0, width: 1, height: 0.12 } },
    })
    expect(text.sections[0]?.text).toContain('Quarterly report')
  })

  it('rejects bad pages and regions', async () => {
    expect(await refusal(read(report, { select: { from: 9 } }))).toBe('out-of-range')
    expect(
      await refusal(
        read(report, { select: { region: { page: 1, x: 0.9, y: 0, width: 0.5, height: 0.5 } } }),
      ),
    ).toBe('out-of-range')
    expect(
      await refusal(
        read(report, { select: { region: { page: 4, x: 0, y: 0, width: 1, height: 1 } } }),
      ),
    ).toBe('out-of-range')
  })

  it('caps a huge page render under the pixel limit', async () => {
    // A 200 x 200 inch poster: rendered at the long edge asked, never past the cap.
    const poster = makePdf([{ drawing: true, width: 14_400, height: 14_400 }])
    const view = await read(poster, { budget: { longEdge: 4096 } })
    expect(view.images[0]).toMatchObject({ width: 4096, height: 4096 })
  })
})

describe('malformed corpus: refused, quickly', () => {
  it('encrypted PDF -> password-protected', async () => {
    const locked = makePdf([{ text: ['secret'] }], { encrypted: true })
    expect(await refusal(read(locked))).toBe('password-protected')
  })

  it('truncated PDF -> malformed or partial, never a hang', async () => {
    for (const cut of [20, 200, Math.floor(report.length / 2)]) {
      const result = await read(report.slice(0, cut)).then(
        (view) => `ok:${String(view.meta.pageCount)}`,
        (error: unknown) => (error instanceof DocumentError ? error.code : 'other'),
      )
      expect(['malformed', 'ok:0', 'ok:1', 'ok:2', 'ok:3']).toContain(result)
    }
  })

  it('oversized-dimension PNG -> too-many-pixels before any decode', async () => {
    const e = env()
    expect(await refusal(read(pngShell(50_000, 50_000), {}, e))).toBe('too-many-pixels')
    expect(e.decodeImage).not.toHaveBeenCalled()
  })

  it('image with a damaged header -> malformed', async () => {
    expect(await refusal(read(pngShell(1, 1).subarray(0, 18)))).toBe('malformed')
  })

  it('garbage bytes -> unsupported', async () => {
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) % 251)
    expect(await refusal(read(garbage))).toBe('unsupported')
  })

  it('zip bomb inside an OOXML container -> detected only, never inflated', async () => {
    const bomb = makeZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: new Uint8Array(32 * 1024 * 1024) },
    ])
    const view = await read(bomb)
    expect(view.meta.kind).toBe('docx')
    expect(view.warnings).toContain('Reading a Word document is not supported yet.')
  })

  it('oversized input -> too-large', async () => {
    const limits = { ...DEFAULT_LIMITS, maxDocumentBytes: 1000 }
    expect(await refusal(extractDocument(report, {}, env(), limits))).toBe('too-large')
  })

  it('empty input -> malformed', async () => {
    expect(await refusal(read(new Uint8Array()))).toBe('malformed')
  })
})

describe('other kinds', () => {
  it('describes a photo from its EXIF, with GPS only when asked', async () => {
    const photo = withExif(
      jpegShell(400, 200),
      makeExif({
        orientation: 6,
        make: 'Pixel',
        dateTimeOriginal: '2026:05:01 12:00:00',
        gps: { lat: 48.8584, latRef: 'N', lon: 2.2945, lonRef: 'E' },
      }),
    )
    const view = await read(photo, { mime: 'image/jpeg' })
    // Orientation 6 turns the stored 400x200 upright: 200x400.
    expect(view.meta).toMatchObject({ kind: 'jpeg', width: 200, height: 400 })
    expect(view.sections[0]?.text).toContain('Camera: Pixel')
    expect(view.sections[0]?.text).not.toContain('48.85')
    expect(view.images).toHaveLength(1)
    expect(view.warnings).toEqual([])
    const located = await read(photo, { includeLocation: true, view: 'text' })
    expect(located.sections[0]?.text).toContain('Location: 48.8584, 2.2945')
    expect(located.images).toHaveLength(0)
  })

  it('warns when the claimed type does not match the contents', async () => {
    const view = await read(report, { mime: 'image/jpeg', view: 'text' })
    expect(view.warnings[0]).toBe('The file says it is image/jpeg but its contents are a PDF.')
  })

  it('says HEIC and Office formats are not supported yet', async () => {
    const heic = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66,
      0x31, 0x68, 0x65, 0x69, 0x63,
    ])
    expect((await read(heic)).warnings[0]).toMatch(/HEIC\/HEIF images are not supported yet/)
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
    expect((await read(ole)).warnings).toEqual([
      'Reading a legacy Office (OLE) file is not supported yet.',
    ])
  })

  it('reads text in character windows', async () => {
    const text = new TextEncoder().encode('abcdefghij')
    const view = await read(text, { select: { from: 3 }, budget: { maxChars: 4 } })
    expect(view.sections[0]?.text).toBe('cdef')
    expect(view.position).toEqual({ unit: 'char', total: 10, shown: { from: 3, to: 6 }, next: 7 })
  })
})
