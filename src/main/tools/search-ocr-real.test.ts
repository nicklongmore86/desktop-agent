// search_files over the real ocr-text.exe on Windows, as `pnpm build:helpers` built it (the
// Windows check job), and the reader's real PDF code in-process (PDFium WASM): generated PDFs
// whose pages are pictures of known text, drawn on the runner by System.Drawing. Fails rather
// than skips on Windows when the helper was not built. Each test logs its numbers for the PR.
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import { promises as fs, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { extractDocument } from '../documents/extract'
import { makePdf, type FixturePage } from '../documents/fixtures.test-util'
import { KNOWN_LINES, renderPage, toGray } from '../documents/ocr-fixtures.test-util'
import {
  createSystemOcr,
  OCR_TEXT_PATH,
  type OcrImage,
  type OcrResult,
  type SystemOcr,
} from '../documents/system-ocr'
import type { DocumentReader, ExtractOptions } from '../documents/types'
import { fakeContext, makeSandbox, put, type Sandbox } from '../permissions/test-support'
import { DocumentTextCache } from './document-text-cache'
import { verifyPinnedHelper } from './job-launcher'
import { readingScore, turnGray } from './search-ocr'
import { toolHarness, type ToolHarness } from './test-support'

const BUILD = path.resolve('build')
const PINS = path.join(BUILD, 'job-helper-pins.json')
const SLOW = 180_000

function pin(): string {
  const hash = (JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, { sha256?: string }>)[
    'helpers/ocr-text.exe'
  ]?.sha256
  if (!hash) throw new Error(`no ocr-text.exe pin in ${PINS}`)
  return hash
}

/** Letter paper's shape at 200 dpi: what a scanner makes. */
const PAGE_WIDTH = 1700
const PAGE_HEIGHT = 2200

let pdfium: WrappedPdfiumModule
const pictures = new Map<string, OcrImage>()

/** A picture of known text, in grey: drawn once per file, by PowerShell. */
function picture(
  name = 'letter',
  lines: readonly string[] = [...KNOWN_LINES, ...KNOWN_LINES],
): OcrImage {
  let found = pictures.get(name)
  if (!found) {
    found = toGray(renderPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT, lines, fontPx: 40 }))
    pictures.set(name, found)
  }
  return found
}

/** A PDF page that is nothing but a picture, sized for it at 200 dpi. */
const scanPage = (image: OcrImage, extra: Partial<FixturePage> = {}): FixturePage => ({
  width: (image.width * 72) / 200,
  height: (image.height * 72) / 200,
  image: { width: image.width, height: image.height, gray: image.pixels },
  ...extra,
})

describe.runIf(process.platform === 'win32')('search_files with the real ocr-text.exe', () => {
  let sb: Sandbox
  let h: ToolHarness
  let cache: DocumentTextCache
  let grant: string | null
  let runs: { width: number; height: number; ms: number }[]
  let rendersMs: number[]
  let duringRun: ((image: OcrImage) => void) | null

  const real = createSystemOcr({
    platform: 'win32',
    findHelper: () =>
      verifyPinnedHelper(
        { resources: BUILD, sha256: pin(), grantedRoots: () => [], platform: 'win32' },
        OCR_TEXT_PATH,
      ),
  })
  /** The real helper, recording each run. */
  const recorded: SystemOcr = {
    probe: (options) => real.probe(options),
    cancelAll: () => {
      real.cancelAll()
    },
    recognize: async (image, options) => {
      duringRun?.(image)
      const result: OcrResult = await real.recognize(image, options)
      runs.push({ width: image.width, height: image.height, ms: result.stats.ms })
      return result
    },
  }
  const reader: DocumentReader = {
    extract: async (bytes, options: ExtractOptions = {}) => {
      const started = performance.now()
      const view = await extractDocument(bytes, options, {
        pdfium: () => Promise.resolve(pdfium),
        encode: () => Promise.reject(new Error('search never encodes')),
        decodeImage: () => Promise.reject(new Error('search never decodes')),
      })
      if (options.view === 'raster') rendersMs.push(performance.now() - started)
      return view
    },
  }

  beforeAll(async () => {
    const require = createRequire(import.meta.url)
    const wasm = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
    pdfium = await init({
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length),
    })
    pdfium.PDFiumExt_Init()
  })

  beforeEach(async () => {
    sb = await makeSandbox()
    grant = 'grant'
    runs = []
    rendersMs = []
    duringRun = null
    cache = new DocumentTextCache({
      dir: path.join(sb.userData, 'document-text-cache'),
      grants: { list: () => [sb.root], token: (root) => (root === sb.root ? grant : null) },
    })
    h = toolHarness(sb, { documents: reader, documentCache: cache, ocr: recorded })
  })

  afterEach(async () => {
    await sb.cleanup()
  })

  const search = (input: Record<string, unknown>, signal?: AbortSignal) =>
    h
      .tool('search_files')
      .execute(
        { path: sb.root, ...input },
        signal ? { ...fakeContext().ctx, signal } : fakeContext().ctx,
      )
  const writePdf = (name: string, pages: FixturePage[]) =>
    put(path.join(sb.root, name), Buffer.from(makePdf(pages)))
  const log = (label: string, startedAt: number, pages: number) => {
    const seconds = (performance.now() - startedAt) / 1000
    const render = rendersMs.reduce((a, b) => a + b, 0) / Math.max(1, rendersMs.length)
    const ocr = runs.reduce((a, b) => a + b.ms, 0) / Math.max(1, runs.length)
    console.log(
      `search-ocr ${label}: ${String(pages)} pages in ${seconds.toFixed(2)} s ` +
        `(${(pages / seconds).toFixed(2)} pages/s), ${String(runs.length)} helper runs, ` +
        `render ${render.toFixed(0)} ms/page, ocr ${ocr.toFixed(0)} ms/run`,
    )
  }

  it(
    'finds text in an image-only PDF, with the page and OCR labelled',
    async () => {
      await writePdf('scan.pdf', [scanPage(picture())])
      const started = performance.now()
      const r = await search({ contentPattern: 'invoice number 48213', context: 0 })
      log('image-only page', started, 1)
      expect(r.content).toContain('scan.pdf (page 1, OCR): Invoice number 48213 dated 3 November')
      expect(r.content).toContain('Every file was checked: 2 matches in 1 file.')
      expect(r.content).toContain('OCR text, marked "(page N, OCR)", can contain errors')
      expect(runs).toHaveLength(1)
    },
    SLOW,
  )

  it(
    'finds a phrase OCR read, flexibly, and a page after pages of text',
    async () => {
      await writePdf('mixed.pdf', [
        { text: ['A cover sheet with some text on it'] },
        scanPage(picture()),
      ])
      const r = await search({ contentPattern: 'SIGNED-CONTRACT', context: 0 })
      expect(r.content).toContain('mixed.pdf (page 2, OCR): Please return the signed contract')
    },
    SLOW,
  )

  it(
    'reads a scan under a stamp, keeping the stamp’s own text',
    async () => {
      await writePdf('stamped.pdf', [scanPage(picture(), { text: ['RFI-014 RECEIVED'] })])
      const r = await search({ anyOf: ['RFI-014', 'total amount due'], context: 0 })
      expect(r.content).toContain('stamped.pdf (page 1): (matched "RFI-014") RFI-014 RECEIVED')
      expect(r.content).toContain(
        'stamped.pdf (page 1, OCR): (matched "total amount due") Total amount due 1284.50',
      )
    },
    SLOW,
  )

  it(
    'reads a sideways scan either way round, turning it as it needs',
    async () => {
      for (const [name, degrees] of [
        ['clockwise.pdf', 90],
        ['anticlockwise.pdf', 270],
      ] as const) {
        runs = []
        rendersMs = []
        const turned = turnGray(picture(), degrees)
        await writePdf(name, [scanPage(turned)])
        const started = performance.now()
        const r = await search({ contentPattern: 'invoice number 48213', context: 0 })
        log(`sideways ${String(degrees)}`, started, 1)
        expect(r.content).toContain(`${name} (page 1, OCR): Invoice number 48213`)
        // As it is, and then at least the turn that reads, at most every turn.
        expect(runs.length).toBeGreaterThanOrEqual(2)
        expect(runs.length).toBeLessThanOrEqual(4)
        await fs.rm(path.join(sb.root, name))
      }
    },
    SLOW,
  )

  it(
    'logs what each orientation of a page reads as, for the scoring',
    async () => {
      const sparse = toGray(
        renderPage({
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
          lines: ['A-101', 'NORTH ELEVATION', 'KITCHEN', 'SCALE 1:50'],
          fontPx: 40,
        }),
      )
      for (const [label, image] of [
        ['letter', picture()],
        ['sparse', sparse],
      ] as const) {
        for (const degrees of [0, 90, 180, 270] as const) {
          const turned = degrees === 0 ? image : turnGray(image, degrees)
          const result = await real.recognize(turned)
          const lines = result.lines.map((line) => line.text)
          const score = readingScore(lines)
          console.log(
            `search-ocr reading ${label} ${String(degrees)}: words ${String(score.words)} of ` +
              `${String(score.all)}, angle ${String(result.angle)}, lines ${String(lines.length)}, ` +
              `${String(result.stats.ms)} ms: ${JSON.stringify(lines.join(' | ').slice(0, 300))}`,
          )
        }
      }
    },
    SLOW,
  )

  it(
    'logs what each orientation of a page reads as, for the scoring',
    async () => {
      const sparse = toGray(
        renderPage({
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
          lines: ['A-101', 'NORTH ELEVATION', 'KITCHEN', 'SCALE 1:50'],
          fontPx: 40,
        }),
      )
      for (const [label, image] of [
        ['letter', picture()],
        ['sparse', sparse],
      ] as const) {
        for (const degrees of [0, 90, 180, 270] as const) {
          const turned = degrees === 0 ? image : turnGray(image, degrees)
          const result = await real.recognize(turned)
          const lines = result.lines.map((line) => line.text)
          const score = readingScore(lines)
          console.log(
            `search-ocr reading ${label} ${String(degrees)}: words ${String(score.words)} of ` +
              `${String(score.all)}, angle ${String(result.angle)}, lines ${String(lines.length)}, ` +
              `${String(result.stats.ms)} ms: ${JSON.stringify(lines.join(' | ').slice(0, 300))}`,
          )
        }
      }
    },
    SLOW,
  )

  it(
    'reads a page rotated by its own /Rotate in one run',
    async () => {
      // The picture stored turned back, as a scanner stores a page it knows is sideways.
      const stored = turnGray(picture(), 270)
      await writePdf('rotated.pdf', [scanPage(stored, { rotate: 90 })])
      const r = await search({ contentPattern: 'invoice number 48213', context: 0 })
      expect(r.content).toContain('rotated.pdf (page 1, OCR): Invoice number 48213')
      expect(runs).toHaveLength(1)
    },
    SLOW,
  )

  it(
    'reads each page once: a repeat search takes nothing from the reader or the helper',
    async () => {
      await writePdf('scan.pdf', [scanPage(picture()), scanPage(picture())])
      const first = await search({ contentPattern: 'invoice number 48213', context: 0 })
      expect(first.content).toContain('scan.pdf (page 2, OCR)')
      expect(runs).toHaveLength(2)
      runs = []
      rendersMs = []
      const started = performance.now()
      const again = await search({ contentPattern: 'invoice number 48213', context: 0 })
      log('repeat from the cache', started, 2)
      expect(again.content).toContain('scan.pdf (page 2, OCR)')
      expect(again.content).toContain('Searched 1 of 1 document (1 from cache).')
      expect(runs).toEqual([])
      expect(rendersMs).toEqual([])
    },
    SLOW,
  )

  it(
    'stops the helper at once on Stop, and picks up from there',
    async () => {
      await writePdf('scan.pdf', [scanPage(picture()), scanPage(picture())])
      const controller = new AbortController()
      let stopped = 0
      duringRun = () => {
        if (stopped === 0) {
          stopped = performance.now()
          setTimeout(() => {
            controller.abort()
          }, 20)
        }
      }
      const r = await search({ contentPattern: 'invoice number 48213' }, controller.signal)
      const took = performance.now() - stopped
      console.log(`search-ocr Stop: back ${took.toFixed(0)} ms after the helper started`)
      expect(r).toEqual({ content: 'Cancelled.', isError: true })
      expect(took).toBeLessThan(5000)
      // Nothing read, so it all comes on the next search, which still works.
      duringRun = null
      const again = await search({ contentPattern: 'invoice number 48213', context: 0 })
      expect(again.content).toContain('Every file was checked: 4 matches in 1 file.')
    },
    SLOW,
  )

  it(
    'keeps nothing when the folder’s grant goes during a page',
    async () => {
      await writePdf('scan.pdf', [scanPage(picture())])
      const removing: Promise<void>[] = []
      duringRun = () => {
        grant = null
        removing.push(cache.forgetGrant(sb.root))
      }
      const r = await search({ contentPattern: 'invoice number 48213' })
      await Promise.all(removing)
      expect(runs).toHaveLength(1)
      expect(r.content).not.toContain('Invoice number')
      expect(r.content).toContain('1 files skipped: 1 unreadable')
      expect(cache.usage().entries).toBe(0)
      const folder = path.join(sb.userData, 'document-text-cache')
      expect(await fs.readdir(folder)).toEqual([])
    },
    SLOW,
  )

  it(
    'measures a run of pages, render and recognition together',
    async () => {
      const count = 12
      await writePdf(
        'book.pdf',
        Array.from({ length: count }, () => scanPage(picture())),
      )
      const started = performance.now()
      const r = await search({ contentPattern: 'invoice number 48213', context: 0, maxPerFile: 50 })
      log('12-page scan', started, count)
      expect(r.content).toContain(`${String(count * 2)} results in`)
    },
    SLOW,
  )
})
