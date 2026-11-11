// Background indexing over the real ocr-text.exe on Windows, as `pnpm build:helpers` built it
// (the Windows check job), and the reader's real PDF code in-process (PDFium WASM): a small
// folder of generated PDFs whose pages are pictures of known text, drawn on the runner by
// System.Drawing. Fails rather than skips on Windows when the helper was not built.
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
  type SystemOcr,
} from '../documents/system-ocr'
import type { DocumentReader, ExtractOptions } from '../documents/types'
import { rootId } from '../files/location'
import { PathGuard } from '../permissions/guard'
import {
  fakeContext,
  makeSandbox,
  MemoryAudit,
  put,
  type Sandbox,
} from '../permissions/test-support'
import { DocumentTextCache } from '../tools/document-text-cache'
import { verifyPinnedHelper } from '../tools/job-launcher'
import { OcrPriority } from '../tools/ocr-priority'
import { toolHarness } from '../tools/test-support'
import { createOcrIndexService, type OcrIndexService } from './service'

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

/** Letter paper at 200 dpi, as a scanner makes it. */
const PAGE_WIDTH = 1700
const PAGE_HEIGHT = 2200

let pdfium: WrappedPdfiumModule
let picture: OcrImage | null = null

/** A page of known text in grey, drawn once by PowerShell. */
function knownPage(): OcrImage {
  picture ??= toGray(
    renderPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT, lines: KNOWN_LINES, fontPx: 40 }),
  )
  return picture
}

/** A PDF page that is nothing but a picture, sized for it at 200 dpi. */
const scanPage = (image: OcrImage): FixturePage => ({
  width: (image.width * 72) / 200,
  height: (image.height * 72) / 200,
  image: { width: image.width, height: image.height, gray: image.pixels },
})

describe.runIf(process.platform === 'win32')(
  'background indexing with the real ocr-text.exe',
  () => {
    let sb: Sandbox
    let cache: DocumentTextCache
    let index: OcrIndexService | null
    let runs: number

    const real = createSystemOcr({
      platform: 'win32',
      helpers: ocrHelpersFor(availableParallelism()),
      findHelper: () =>
        verifyPinnedHelper(
          { resources: BUILD, sha256: pin(), grantedRoots: () => [], platform: 'win32' },
          OCR_TEXT_PATH,
        ),
    })
    /** The real helper, counting runs. */
    const counted: SystemOcr = {
      helpers: real.helpers ?? 1,
      onBattery: () => false,
      probe: (options) => real.probe(options),
      cancelAll: () => {
        real.cancelAll()
      },
      recognize: async (image, options) => {
        const result = await real.recognize(image, options)
        runs++
        return result
      },
    }
    const reader: DocumentReader = {
      extract: (bytes, options: ExtractOptions = {}) =>
        extractDocument(bytes, options, {
          pdfium: () => Promise.resolve(pdfium),
          encode: () => Promise.reject(new Error('indexing never encodes')),
          decodeImage: () => Promise.reject(new Error('indexing never decodes')),
        }),
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
      runs = 0
      index = null
      cache = new DocumentTextCache({
        dir: path.join(sb.userData, 'document-text-cache'),
        grants: { list: () => [sb.root], token: (root) => (root === sb.root ? 'grant' : null) },
      })
    })

    afterEach(async () => {
      await index?.dispose()
      await sb.cleanup()
    })

    it(
      'reads a small folder of scanned PDFs, and a search then finds the text without OCR',
      async () => {
        const page = knownPage()
        await put(path.join(sb.root, 'rfi/0147.pdf'), Buffer.from(makePdf([scanPage(page)])))
        await put(
          path.join(sb.root, 'rfi/0148.pdf'),
          Buffer.from(makePdf([{ text: ['A cover sheet with some text on it'] }, scanPage(page)])),
        )
        const guard = new PathGuard({ roots: () => [sb.root], protectedPaths: [sb.userData] })
        const priority = new OcrPriority()
        const audit = new MemoryAudit()
        const service = createOcrIndexService({
          guard,
          reader,
          ocr: counted,
          cache,
          priority,
          audit,
          stateFile: path.join(sb.userData, 'ocr-index.json'),
          emit: () => undefined,
          limits: { pollMs: 20, emitEveryMs: 20 },
        })
        index = service
        const started = performance.now()
        expect(await service.start({ rootId: rootId(sb.root), rel: 'rfi' })).toEqual({ ok: true })
        for (let waited = 0; service.list()[0]?.state !== 'finished'; waited += 50) {
          if (waited > SLOW - 10_000) throw new Error(`still ${String(service.list()[0]?.state)}`)
          expect(service.list()[0]?.state).not.toBe('stopped')
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const seconds = (performance.now() - started) / 1000
        console.log(
          `ocr-index real: 2 scanned pages in ${seconds.toFixed(2)} s, ${String(runs)} helper runs`,
        )
        expect(service.list()[0]).toMatchObject({ pagesDone: 2, pagesTotal: 2, filesChecked: 2 })
        expect(runs).toBe(2)

        const before = runs
        const r = await toolHarness(sb, {
          documents: reader,
          documentCache: cache,
          ocr: counted,
          ocrPriority: priority,
          ocrIndex: service,
        })
          .tool('search_files')
          .execute(
            { path: sb.root, contentPattern: 'invoice number 48213', context: 0 },
            fakeContext().ctx,
          )
        expect(r.content).toContain('0147.pdf (page 1, OCR): Invoice number 48213')
        expect(r.content).toContain('0148.pdf (page 2, OCR): Invoice number 48213')
        expect(runs).toBe(before)
        expect(await fs.readdir(path.join(sb.userData, 'document-text-cache'))).toHaveLength(1)
      },
      SLOW,
    )
  },
)
