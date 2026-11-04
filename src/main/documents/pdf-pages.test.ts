import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { extractDocument, type ExtractEnv } from './extract'
import { makePdf, type FixtureImage, type FixturePage } from './fixtures.test-util'
import { DEFAULT_LIMITS } from './limits'
import { checkReply } from './reply'
import { DocumentError, type ExtractOptions, type PageLayout, type PageRaster } from './types'

/**
 * What the reader says about PDF pages for OCR, with the real PDFium WASM: each page's layout,
 * and a page's raw grey pixels. Every reply is also passed through checkReply, as the broker
 * and main do with the worker's.
 */

let pdfium: WrappedPdfiumModule

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasm = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
  pdfium = await init({
    wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length),
  })
  pdfium.PDFiumExt_Init()
})

const env: ExtractEnv = {
  pdfium: () => Promise.resolve(pdfium),
  encode: () => Promise.reject(new Error('rasters are not encoded')),
  decodeImage: () => Promise.reject(new Error('not an image')),
}

const read = async (bytes: Uint8Array, options: ExtractOptions) => {
  const view = await extractDocument(bytes, options, env)
  const checked = checkReply(
    { type: 'result', id: 1, view },
    { id: 1, options, limits: DEFAULT_LIMITS },
  )
  if (checked.type !== 'result') throw new Error('not a result')
  return checked.view
}

/** A picture: white, with a black block in its top left quarter. */
function picture(width = 60, height = 80): FixtureImage {
  const gray = new Uint8Array(width * height).fill(255)
  for (let y = 0; y < height / 4; y++) gray.fill(0, y * width, y * width + Math.floor(width / 4))
  return { width, height, gray }
}

const layouts = async (pages: FixturePage[]): Promise<PageLayout[]> => {
  const view = await read(makePdf(pages), { view: 'text', pageLayout: true })
  return view.sections.map((section) => section.layout as PageLayout)
}

describe('PDF page layouts', () => {
  it('says what is on each page, when asked', async () => {
    const pages = await layouts([
      { text: ['A page of ordinary text'] },
      { image: picture() },
      { image: picture(), text: ['RFI-014'] },
      { image: { ...picture(), box: [100, 100, 100, 100] } },
      { drawing: true },
      {},
    ])
    // Text only.
    expect(pages[0]).toMatchObject({ imageCoverage: 0, ink: false, longEdgePoints: 792 })
    // A page-sized scan.
    expect(pages[1]?.imageCoverage).toBeCloseTo(1, 2)
    expect(pages[1]?.ink).toBe(true)
    // A scan with a stamp: its text is a sliver of the page.
    expect(pages[2]?.imageCoverage).toBeCloseTo(1, 2)
    expect(pages[2]?.textCoverage).toBeGreaterThan(0)
    expect(pages[2]?.textCoverage).toBeLessThan(0.01)
    // A small picture on a page.
    expect(pages[3]?.imageCoverage).toBeCloseTo(10_000 / (612 * 792), 2)
    expect(pages[3]?.textCoverage).toBe(0)
    // Paths are ink, a page with nothing on it is not.
    expect(pages[4]).toMatchObject({ imageCoverage: 0, ink: true })
    expect(pages[5]).toMatchObject({ imageCoverage: 0, ink: false })

    const plain = await read(makePdf([{ image: picture() }]), { view: 'text' })
    expect(plain.sections[0]?.layout).toBeUndefined()
  })

  it('finds a scan inside a form XObject, as some scanners wrap one', async () => {
    const [page] = await layouts([{ image: { ...picture(), inForm: true } }])
    expect(page?.imageCoverage).toBeCloseTo(1, 2)
    expect(page?.ink).toBe(true)
  })

  it('measures invisible text: a scan with its own OCR layer is mostly text', async () => {
    const text = Array.from({ length: 45 }, (_, i) => `Line ${String(i)} `.padEnd(90, 'x'))
    const [page] = await layouts([{ image: picture(), text, invisibleText: true }])
    expect(page?.imageCoverage).toBeCloseTo(1, 2)
    expect(page?.textCoverage).toBeGreaterThan(0.2)
  })

  it('caps an image larger than the page at the whole page', async () => {
    const [page] = await layouts([{ image: { ...picture(), box: [-100, -100, 900, 1000] } }])
    expect(page?.imageCoverage).toBe(1)
  })

  describe('says when part of a page went unmeasured', () => {
    const CAP = 5000
    const lines = (count: number): string[] => Array.from({ length: count }, () => 'x')

    it('at the object cap, with a page-sized image past it', async () => {
      const [page] = await layouts([{ text: lines(CAP), image: { ...picture(), last: true } }])
      expect(page).toMatchObject({ imageCoverage: 0, ink: false, incomplete: true })
    })

    it('when the cap cuts into a form that holds the image', async () => {
      const image = { ...picture(), inForm: true, last: true }
      const [page] = await layouts([{ text: lines(CAP - 1), image }])
      expect(page).toMatchObject({ imageCoverage: 0, ink: false, incomplete: true })
    })

    it('with forms nested past the depth limit', async () => {
      const [page] = await layouts([
        { image: { ...picture(), inForm: 5 }, text: ['RFI-014 stamp'] },
      ])
      expect(page).toMatchObject({ imageCoverage: 0, ink: true, incomplete: true })
    })

    it('with an image whose bounds cannot be read', async () => {
      const bounds = vi.spyOn(pdfium, 'FPDFPageObj_GetBounds').mockReturnValue(false)
      try {
        const [page] = await layouts([{ image: picture() }])
        expect(page).toMatchObject({ imageCoverage: 0, ink: true, incomplete: true })
      } finally {
        bounds.mockRestore()
      }
    })

    it('but not when every object was looked at, up to the cap and its deepest form', async () => {
      const pages = await layouts([
        { text: lines(CAP) },
        { image: { ...picture(), inForm: 4 } },
        { image: picture() },
      ])
      expect(pages[0]).toMatchObject({ ink: false, incomplete: false })
      expect(pages[1]).toMatchObject({ ink: true, incomplete: false })
      expect(pages[1]?.imageCoverage).toBeCloseTo(1, 2)
      expect(pages[2]?.incomplete).toBe(false)
    })
  })
})

describe('PDF pages as raw grey pixels', () => {
  const raster = async (pages: FixturePage[], options: ExtractOptions = {}) => {
    const view = await read(makePdf(pages), {
      view: 'raster',
      select: { from: 1 },
      budget: { longEdge: 400, maxImages: 0, maxChars: 1 },
      ...options,
    })
    expect(view.rasters).toHaveLength(1)
    return { view, raster: view.rasters?.[0] as PageRaster }
  }
  const darkest = (r: PageRaster, x0: number, y0: number, x1: number, y1: number): number => {
    let dark = 255
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) dark = Math.min(dark, r.pixels[y * r.width + x] ?? 255)
    }
    return dark
  }

  it('renders one page, exactly its size in grey bytes, at the long edge asked for', async () => {
    const pages = [{ image: picture() }, { image: picture() }, { text: ['third'] }]
    const { view, raster: r } = await raster(pages, { select: { from: 2 } })
    expect(r).toMatchObject({ page: 2, width: 309, height: 400 })
    expect(r.pixels.byteLength).toBe(309 * 400)
    expect(view.position).toEqual({ unit: 'page', total: 3, shown: { from: 2, to: 2 }, next: 3 })
    expect(view.sections).toEqual([])
    expect(view.images).toEqual([])
    // The block is in the top left of the picture, and white stays white.
    expect(darkest(r, 0, 0, 60, 80)).toBeLessThan(10)
    expect(darkest(r, 200, 200, 309, 400)).toBeGreaterThan(245)
  })

  it('applies the page’s own /Rotate, so a turned page comes out as a viewer shows it', async () => {
    const { raster: r } = await raster([{ image: picture(), rotate: 90 }])
    // Portrait media box, turned a quarter clockwise: landscape, top left now top right.
    expect(r).toMatchObject({ width: 400, height: 309 })
    expect(darkest(r, 340, 0, 400, 60)).toBeLessThan(10)
    expect(darkest(r, 0, 0, 200, 309)).toBeGreaterThan(245)
  })

  it('draws annotations and text too, on white', async () => {
    const { raster: r } = await raster([{ text: ['Printed text on the page'] }])
    expect(darkest(r, 0, 0, r.width, r.height)).toBeLessThan(120)
  })

  it('is only for PDFs', async () => {
    await expect(
      extractDocument(new TextEncoder().encode('plain text'), { view: 'raster' }, env),
    ).rejects.toMatchObject({ code: 'unsupported' } satisfies Partial<DocumentError>)
  })

  it('refuses a page past the end', async () => {
    await expect(
      read(makePdf([{ text: ['one'] }]), { view: 'raster', select: { from: 2 } }),
    ).rejects.toMatchObject({ code: 'out-of-range' } satisfies Partial<DocumentError>)
  })
})
