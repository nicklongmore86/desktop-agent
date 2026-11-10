// search_files over the real ocr-text.exe on Windows, as `pnpm build:helpers` built it (the
// Windows check job), and the reader's real PDF code in-process (PDFium WASM): generated PDFs
// whose pages are pictures of known text, drawn on the runner by System.Drawing. Fails rather
// than skips on Windows when the helper was not built. Each test logs its numbers for the PR.
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import { promises as fs, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { extractDocument } from '../documents/extract'
import { makePdf, type FixturePage } from '../documents/fixtures.test-util'
import { KNOWN_LINES, renderPage, toGray } from '../documents/ocr-fixtures.test-util'
import {
  createSystemOcr,
  OCR_TEXT_PATH,
  ocrHelpersFor,
  type OcrImage,
  type OcrResult,
  type SystemOcr,
} from '../documents/system-ocr'
import type { DocumentReader, ExtractOptions } from '../documents/types'
import { fakeContext, makeSandbox, put, type Sandbox } from '../permissions/test-support'
import { DocumentTextCache } from './document-text-cache'
import { verifyPinnedHelper } from './job-launcher'
import { textAxis, turnGray } from './search-ocr'
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
  angle = 0,
): OcrImage {
  let found = pictures.get(name)
  if (!found) {
    found = toGray(renderPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT, lines, fontPx: 40, angle }))
    pictures.set(name, found)
  }
  return found
}

/** An RFI cover sheet's text. */
const RFI_LINES = [
  'RFI 0147 response required by 14 November 2026',
  'Contractor proposes an alternate anchor bolt detail',
  'See structural drawing S-301 at grid line C between 4 and 5',
  'Engineer of record to confirm the embedment depth',
  'Attached sketch shows the revised base plate layout',
  'Please reply before the concrete pour is scheduled',
]
/** A hand sketch's few labels. */
const SKETCH_LINES = ['SK-12', 'EMBED PLATE', 'TYP. AT GRID C/4', 'SCALE 1:20']

/**
 * A scanner's copy: grey paper, ink not quite black, a little noise and speckle. Milder
 * than ocr-fixtures' degrade(), so 16 pages of it still make a PDF of a realistic size.
 */
function scanned(page: OcrImage, seed = 5): OcrImage {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  const pixels = new Uint8Array(page.pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    const roll = next()
    const value =
      roll < 0.002 ? 40 : 40 + ((page.pixels[i] ?? 0) * 190) / 255 + Math.floor(next() * 4) * 2
    pixels[i] = Math.min(255, Math.round(value))
  }
  return { ...page, pixels }
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
  let runs: { width: number; height: number; ms: number; angle: number | null }[]
  let rendersMs: number[]
  let duringRun: ((image: OcrImage) => void) | null

  const real = createSystemOcr({
    platform: 'win32',
    helpers: ocrHelpersFor(availableParallelism()),
    findHelper: () =>
      verifyPinnedHelper(
        { resources: BUILD, sha256: pin(), grantedRoots: () => [], platform: 'win32' },
        OCR_TEXT_PATH,
      ),
  })
  /** The real helper, recording each run. */
  const recorded: SystemOcr = {
    helpers: real.helpers ?? 1,
    probe: (options) => real.probe(options),
    cancelAll: () => {
      real.cancelAll()
    },
    recognize: async (image, options) => {
      duringRun?.(image)
      const result: OcrResult = await real.recognize(image, options)
      runs.push({
        width: image.width,
        height: image.height,
        ms: result.stats.ms,
        angle: result.angle,
      })
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
        // Its lines are seen to run down it: a quarter turn, and the other quarter if that
        // was the wrong one. No probe.
        expect(runs.length).toBeGreaterThanOrEqual(1)
        expect(runs.length).toBeLessThanOrEqual(2)
        await fs.rm(path.join(sb.root, name))
      }
    },
    SLOW,
  )

  it(
    'reads an upside-down scan, which reads as plenty of letters as it is',
    async () => {
      await writePdf('flipped.pdf', [scanPage(turnGray(picture(), 180))])
      const started = performance.now()
      const r = await search({ contentPattern: 'invoice number 48213', context: 0 })
      log('upside down', started, 1)
      expect(r.content).toContain('flipped.pdf (page 1, OCR): Invoice number 48213')
      // Its lines are seen to run across it: as it is, then 180. No probe.
      expect(runs).toHaveLength(2)
    },
    SLOW,
  )

  it(
    'keeps what it read of a sparse page, the right way up, saying it was little',
    async () => {
      const sparse = toGray(
        renderPage({
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
          lines: ['A-101', 'NORTH ELEVATION', 'KITCHEN', 'SCALE 1:50'],
          fontPx: 40,
        }),
      )
      await writePdf('plan.pdf', [scanPage(sparse)])
      const started = performance.now()
      const r = await search({ contentPattern: 'north elevation', context: 0 })
      log('sparse page', started, 1)
      expect(r.content).toContain('plan.pdf (page 1, OCR): NORTH ELEVATION')
      expect(r.content).toContain('OCR found little text on 1 of 1 scanned page')
      // Both ways up along the lines it shows; or, if they can't be told, as it is, one
      // probe, and a turn at full size only if the probe read more there.
      expect(runs.length).toBeGreaterThanOrEqual(2)
      expect(runs.length).toBeLessThanOrEqual(3)
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

  it(
    'measures a realistic RFI scan: noisy pages, mixed orientation and a sparse sketch',
    async () => {
      // What a scanned RFI set looks like: 200 dpi letter pages on grey paper with scanner
      // noise and speckle, slightly skewed, mostly the right way up; runs of landscape sheets
      // stored sideways, one the other way, one upside down, and hand sketches with a few
      // labels, one of them sideways.
      const letter = scanned(picture())
      const rfi = scanned(picture('rfi', RFI_LINES, 1.2), 11)
      const sketch = scanned(picture('sketch', SKETCH_LINES), 23)
      const set: [OcrImage, 0 | 90 | 180 | 270][] = [
        [letter, 0],
        [rfi, 0],
        [rfi, 90],
        [letter, 90],
        [rfi, 90],
        [letter, 90],
        [sketch, 0],
        [letter, 0],
        [rfi, 270],
        [letter, 0],
        [sketch, 90],
        [rfi, 180],
        [letter, 0],
        [rfi, 0],
        [letter, 90],
        [rfi, 0],
      ]
      const pdf = Buffer.from(
        makePdf(set.map(([image, turn]) => scanPage(turn === 0 ? image : turnGray(image, turn)))),
      )
      const pagesOf = (image: OcrImage): number[] =>
        set.flatMap(([page], index) => (page === image ? [index + 1] : []))
      // One helper, then as many as this PC gets (two on a 4-core runner), each from scratch.
      const most = ocrHelpersFor(availableParallelism())
      for (const helpers of most > 1 ? [1, most] : [1]) {
        const folder = path.join(sb.root, `helpers-${String(helpers)}`)
        await put(path.join(folder, 'rfi-set.pdf'), pdf)
        const tool = toolHarness(sb, {
          documents: reader,
          documentCache: cache,
          ocr: { ...recorded, helpers },
        }).tool('search_files')
        runs = []
        rendersMs = []
        const started = performance.now()
        const contents: string[] = []
        let cursor: string | null = null
        do {
          const r = await tool.execute(
            {
              path: folder,
              anyOf: ['embedment depth', 'invoice number 48213', 'embed plate'],
              context: 0,
              maxPerFile: 200,
              ...(cursor ? { cursor } : {}),
            },
            fakeContext().ctx,
          )
          contents.push(r.content)
          cursor = /cursor: "(sf1\.[\w-]+)"\.$/m.exec(r.content)?.[1] ?? null
        } while (cursor && contents.length < 10)
        const label = `16-page RFI set, ${String(helpers)} helper${helpers === 1 ? '' : 's'}`
        log(label, started, set.length)
        // A probe is any run not of a whole page, either way round.
        const probes = runs.filter(
          (run) =>
            !(run.width === PAGE_WIDTH && run.height === PAGE_HEIGHT) &&
            !(run.width === PAGE_HEIGHT && run.height === PAGE_WIDTH),
        )
        console.log(
          `search-ocr ${label}: ${(runs.length / set.length).toFixed(2)} helper runs/page ` +
            `(${String(probes.length)} of them probes); lines seen running ` +
            `${JSON.stringify(set.map(([image, turn]) => textAxis(turn === 0 ? image : turnGray(image, turn))))}; ` +
            `angles ${JSON.stringify(runs.map((run) => run.angle))}`,
        )
        const found = (phrase: string): Set<number> =>
          new Set(
            contents
              .join('\n')
              .split('\n')
              .flatMap((line) => {
                const at = new RegExp(
                  `^rfi-set\\.pdf \\(page (\\d+), OCR\\): \\(matched "${phrase}"\\)`,
                  'i',
                ).exec(line)
                return at ? [Number(at[1])] : []
              }),
          )
        // Every page read its right way round, whichever way it was stored.
        expect(found('embedment depth')).toEqual(new Set(pagesOf(rfi)))
        expect(found('invoice number 48213')).toEqual(new Set(pagesOf(letter)))
        expect(found('embed plate')).toEqual(new Set(pagesOf(sketch)))
        // Against 1.6 to 2.0 measured on real RFI folders with turns tried at full size, and
        // 2.31 on this set (main, one helper). Pages read side by side can't take the turn
        // the page beside them is still finding: up to a run more where orientation changes
        // (1.50 with one helper, 1.63 with two, measured on windows-latest).
        expect(runs.length / set.length).toBeLessThan(helpers === 1 ? 1.6 : 1.8)
      }
    },
    6 * SLOW,
  )
})
