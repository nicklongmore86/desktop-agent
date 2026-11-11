// Helpers for the background indexing tests. Not imported by app code.
import { OcrError, type OcrImage, type OcrResult, type SystemOcr } from '../documents/system-ocr'
import type {
  DocumentReader,
  DocumentView,
  ExtractControl,
  ExtractOptions,
  PageLayout,
} from '../documents/types'

/** A line OCR reads well (well-formed words, plenty of them): one helper run per page. */
export const SENTENCE =
  'Walk-in freezer door seals are shown on drawing A-501 with the heated threshold'

/** A scripted PDF page: a scan OCR reads as `ocr`, or a page of text. */
export interface PageSpec {
  text?: string
  ocr?: string[]
  /** The helper fails on this page, in a way worth trying again. */
  fails?: boolean
}

/** A scripted PDF the fake reader understands: a PDF header, then its pages as JSON. */
export const scriptedPdf = (...pages: PageSpec[]): Buffer =>
  Buffer.from(`%PDF-1.7\n${JSON.stringify(pages)}`, 'utf8')

/** A PDF of `n` scanned pages, each reading `${label} page N` and the sentence. */
export const scans = (n: number, label: string): Buffer =>
  scriptedPdf(
    ...Array.from({ length: n }, (_, i) => ({
      ocr: [`${label} page ${String(i + 1)}`, SENTENCE],
    })),
  )

const parse = (bytes: Uint8Array): PageSpec[] =>
  JSON.parse(Buffer.from(bytes).toString('utf8').split('\n')[1] ?? '[]') as PageSpec[]

const SCAN: PageLayout = {
  imageCoverage: 1,
  textCoverage: 0,
  ink: true,
  incomplete: false,
  longEdgePoints: 792,
}
const TEXT: PageLayout = { ...SCAN, imageCoverage: 0, ink: false }

const WIDTH = 20
const HEIGHT = 30

export interface ScriptedReader extends DocumentReader {
  calls: { name: string; view: string; page: number | null; background: boolean }[]
  /** Called before a page is rendered; may hold it. */
  beforeRaster?: (name: string, page: number) => void | Promise<void>
  rendered: Map<number, { name: string; page: number; spec: PageSpec }>
}

/** A reader for scriptedPdf files: their text with page layouts, and a raster per page. */
export function scriptedReader(): ScriptedReader {
  let next = 0
  const reader: ScriptedReader = {
    calls: [],
    rendered: new Map(),
    async extract(bytes, options: ExtractOptions = {}, control: ExtractControl = {}) {
      const name = options.name ?? ''
      const specs = parse(bytes)
      reader.calls.push({
        name,
        view: options.view ?? 'text',
        page: options.select?.from ?? null,
        background: control.background === true,
      })
      const base = {
        meta: { kind: 'pdf' as const, mime: 'application/pdf', pageCount: specs.length },
        images: [],
        warnings: [],
      }
      if (options.view === 'raster') {
        const page = options.select?.from ?? 1
        await reader.beforeRaster?.(name, page)
        if (control.signal?.aborted) throw new Error('aborted')
        // Codes 64 to 254, round and round: never two held at once with the same.
        const code = 64 + (next++ % 191)
        reader.rendered.set(code, { name, page, spec: specs[page - 1] ?? {} })
        const pixels = new Uint8Array(WIDTH * HEIGHT).fill(code)
        for (let y = 0; y < 8; y++) pixels.fill(0, y * WIDTH, y * WIDTH + 8)
        return {
          ...base,
          sections: [],
          rasters: [{ page, width: WIDTH, height: HEIGHT, pixels }],
          position: {
            unit: 'page',
            total: specs.length,
            shown: { from: page, to: page },
            next: null,
          },
        } satisfies DocumentView
      }
      return {
        ...base,
        sections: specs.map((spec, index) => ({
          page: index + 1,
          text: spec.text ?? '',
          layout: spec.ocr || spec.fails ? SCAN : TEXT,
        })),
        position: {
          unit: 'page',
          total: specs.length,
          shown: { from: 1, to: specs.length },
          next: null,
        },
      } satisfies DocumentView
    },
  }
  return reader
}

export interface FakeOcr extends SystemOcr {
  /** Every helper run that read a page, by "name#page". */
  reads: string[]
  /** Runs that were stopped (cancelled) before they read anything. */
  stopped: string[]
  /** Called before a page is read; may hold it. */
  before?: (name: string, page: number) => void | Promise<void>
  available: boolean
  battery: boolean
}

/** The page an image is of: its commonest grey that is not the black mark. */
function codeOf(image: OcrImage): number {
  const counts = new Map<number, number>()
  for (const value of image.pixels) if (value !== 0) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1
}

/** A fake OCR reading what the scripted pages say, with up to two helpers. */
export function fakeOcr(reader: ScriptedReader): FakeOcr {
  const ocr: FakeOcr = {
    reads: [],
    stopped: [],
    available: true,
    battery: false,
    helpers: 2,
    onBattery: () => ocr.battery,
    probe: () =>
      Promise.resolve(
        ocr.available
          ? { available: true, languages: ['en-US'], userLanguage: 'en-US' }
          : {
              available: false,
              reason: 'unsupported',
              message: 'Reading scanned pages needs Windows.',
              languages: [],
            },
      ),
    async recognize(image, options = {}): Promise<OcrResult> {
      const found = reader.rendered.get(codeOf(image))
      if (!found) throw new Error('nothing rendered')
      const label = `${found.name}#${String(found.page)}`
      // A held page still stops when cancelled, as the real helper is killed.
      const signal = options.signal
      await Promise.race([
        ocr.before?.(found.name, found.page),
        new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          signal?.addEventListener('abort', () => {
            resolve()
          })
        }),
      ])
      if (signal?.aborted) {
        ocr.stopped.push(label)
        throw new OcrError('cancelled', 'cancelled')
      }
      if (found.spec.fails) throw new OcrError('failed', 'failed here')
      ocr.reads.push(label)
      return {
        language: 'en-US',
        angle: null,
        width: image.width,
        height: image.height,
        lines: (found.spec.ocr ?? []).map((text) => ({
          text,
          box: { x: 0, y: 0, width: 1, height: 1 },
        })),
        truncated: false,
        stats: { ms: 1, peakBytes: 1 },
      }
    },
    cancelAll: () => undefined,
  }
  return ocr
}

/** A promise and its resolve: holds a fake until a test lets it go. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/** Waits until `check` holds, looking every few ms; fails after `ms`. */
export async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
