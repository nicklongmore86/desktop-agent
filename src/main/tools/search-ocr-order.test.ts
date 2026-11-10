import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrImage, OcrResult, SystemOcr } from '../documents/system-ocr'
import type { DocumentReader, DocumentView, PageLayout } from '../documents/types'
import { fakeContext, makeSandbox, put, type Sandbox } from '../permissions/test-support'
import type { ToolDeps } from './deps'
import { DocumentTextCache } from './document-text-cache'
import { ReportedSets, reportedSets } from './search-cursor'
import { MAX_FILES_LISTED } from './search-files'
import { toolHarness, type ToolHarness } from './test-support'

// Real files on disk, as in search-ocr.test.ts: slow under load, so a generous limit.
vi.setConfig({ testTimeout: 30_000 })

/**
 * The order search_files reads scanned PDFs in, and how it reports them across calls: the
 * likeliest first (a query term in the path, then a text layer that matched, then the rest in
 * path order), each reported as soon as its OCR is done, and every file once over the cursors.
 */

/** A scripted PDF page: its text layer, and the lines OCR reads on it (which make it a scan). */
interface PageSpec {
  text?: string
  ocr?: string[]
}

const SCAN_LAYOUT: PageLayout = {
  imageCoverage: 1,
  textCoverage: 0,
  ink: true,
  incomplete: false,
  longEdgePoints: 792,
}
const TEXT_LAYOUT: PageLayout = { ...SCAN_LAYOUT, imageCoverage: 0, ink: false }
const doc = (...pages: PageSpec[]): Buffer =>
  Buffer.from(`%PDF-1.7\n${JSON.stringify(pages)}`, 'utf8')
const parseDoc = (bytes: Uint8Array): PageSpec[] =>
  JSON.parse(Buffer.from(bytes).toString('utf8').split('\n')[1] ?? '[]') as PageSpec[]
const NOISE = 'Concrete pour schedule for the north stair core and its formwork sequence'
const scan = (line = NOISE): PageSpec => ({ ocr: [line] })

interface ScriptedReader extends DocumentReader {
  current: { name: string; spec: PageSpec; page: number } | null
}

function scriptedReader(): ScriptedReader {
  const reader: ScriptedReader = {
    current: null,
    extract(bytes, options = {}) {
      const specs = parseDoc(bytes)
      const base = {
        meta: { kind: 'pdf' as const, mime: 'application/pdf', pageCount: specs.length },
        images: [],
        warnings: [],
      }
      if (options.view === 'raster') {
        const page = options.select?.from ?? 1
        reader.current = { name: options.name ?? '', spec: specs[page - 1] ?? {}, page }
        return Promise.resolve({
          ...base,
          sections: [],
          rasters: [{ page, width: 4, height: 8, pixels: new Uint8Array(32).map((_, i) => i * 8) }],
          position: {
            unit: 'page',
            total: specs.length,
            shown: { from: page, to: page },
            next: null,
          },
        } satisfies DocumentView)
      }
      return Promise.resolve({
        ...base,
        sections: specs.map((spec, index) => ({
          page: index + 1,
          text: spec.text ?? '',
          layout: spec.ocr ? SCAN_LAYOUT : TEXT_LAYOUT,
        })),
        position: {
          unit: 'page',
          total: specs.length,
          shown: { from: 1, to: specs.length },
          next: null,
        },
      } satisfies DocumentView)
    },
  }
  return reader
}

interface FakeOcr extends SystemOcr {
  runs: { name: string; page: number }[]
}

/** A fake OCR reading what the page last rendered holds; each run moves `clock` on by `ms`. */
function fakeOcr(reader: ScriptedReader, clock: { now: number }, ms: number): FakeOcr {
  const ocr: FakeOcr = {
    runs: [],
    probe: () => Promise.resolve({ available: true, languages: ['en-US'], userLanguage: 'en-US' }),
    recognize(image: OcrImage) {
      const current = reader.current
      if (!current) throw new Error('nothing was rendered')
      ocr.runs.push({ name: current.name, page: current.page })
      clock.now += ms
      return Promise.resolve({
        language: 'en-US',
        angle: null,
        width: image.width,
        height: image.height,
        lines: (current.spec.ocr ?? []).map((text) => ({
          text,
          box: { x: 0, y: 0, width: 1, height: 1 },
        })),
        truncated: false,
        stats: { ms: 1, peakBytes: 1 },
      } satisfies OcrResult)
    },
    cancelAll: () => undefined,
  }
  return ocr
}

let sb: Sandbox
let h: ToolHarness
let reader: ScriptedReader
let ocr: FakeOcr
let cache: DocumentTextCache
let clock: { now: number }

/** A search whose OCR costs 100 ms a page against a `budgetMs` time limit. */
const harness = (budgetMs: number, overrides: Partial<ToolDeps> = {}) =>
  toolHarness(sb, {
    documents: reader,
    documentCache: cache,
    ocr,
    now: () => clock.now,
    ...overrides,
    limits: { searchTimeMs: budgetMs, ...overrides.limits },
  })

beforeEach(async () => {
  sb = await makeSandbox()
  clock = { now: 0 }
  reader = scriptedReader()
  ocr = fakeOcr(reader, clock, 100)
  cache = new DocumentTextCache({
    dir: path.join(sb.userData, 'document-text-cache'),
    grants: { list: () => [sb.root], token: (root) => (root === sb.root ? 'grant' : null) },
  })
  h = harness(60_000)
})

afterEach(async () => {
  await sb.cleanup()
})

const search = (input: Record<string, unknown>) =>
  h.tool('search_files').execute({ path: sb.root, ...input }, fakeContext().ctx)
const lines = (content: string) => content.split('\n')
const cursorOf = (content: string): string | null =>
  /cursor: "(sf1\.[\w-]+)"\.$/m.exec(content)?.[1] ?? null
const ocrNames = (): string[] => [...new Set(ocr.runs.map((run) => run.name))]

/** The files a call reported with match counts (the list after "Files with matches"). */
const reportedFiles = (contents: string[]): string[] =>
  contents.flatMap((content) => {
    const out = lines(content)
    const at = out.findIndex((line) => line.startsWith('Files with matches ('))
    if (at < 0) return []
    const files: string[] = []
    for (const line of out.slice(at + 1)) {
      if (!line.startsWith('  ')) break
      const name = / \(\d+ match(es)?\)$/.exec(line)
      if (name) files.push(line.trim().slice(0, line.trim().length - name[0].length))
    }
    return files
  })

/**
 * Every call of a search, following its cursor until it gives none; each call starts a new
 * time budget of `budgetMs`.
 */
async function follow(
  input: Record<string, unknown>,
  budgetMs: number,
  limit = 60,
  overrides: Partial<ToolDeps> = {},
) {
  const contents: string[] = []
  let cursor: string | null = null
  do {
    clock.now = 0
    h = harness(budgetMs, overrides)
    const r = await search({ ...input, ...(cursor ? { cursor } : {}) })
    expect(r.isError).toBeUndefined()
    contents.push(r.content)
    cursor = cursorOf(r.content)
  } while (cursor && contents.length < limit)
  expect(cursor).toBeNull()
  return contents
}

/** The order key's shape, so tests can sort names in the search's path order. */
const byPath = (a: string, b: string): number => {
  const ka = a.split('/').join('\u0000')
  const kb = b.split('/').join('\u0000')
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

describe('search_files OCR order', () => {
  it('reads and reports a scanned RFI named for the query first, however deep in path order', async () => {
    // As seen in use: a query about a closet, fan and duct route; the RFI whose name says
    // "Duct Routing" came after hundreds of other scanned RFIs, so it only surfaced on the
    // sixth three-minute call. Now its OCR comes first, and it is reported in the first call.
    for (let i = 100; i < 160; i++) {
      await put(
        path.join(sb.root, 'RFIs', `RFI ${String(i)} Structural`, `RFI ${String(i)}.pdf`),
        doc(scan(), scan()),
      )
    }
    const target = 'RFIs/RFI 207 HVAC - Duct Routing/RFI 207 - HVAC-Duct_Routing 2024-0729.pdf'
    await put(
      path.join(sb.root, ...target.split('/')),
      doc(
        scan('Transmittal cover sheet for the mechanical consultant review package'),
        scan('Reroute the supply duct above the closet to clear the exhaust fan'),
      ),
    )
    for (let i = 300; i < 340; i++) {
      await put(path.join(sb.root, 'RFIs', `RFI ${String(i)} Civil.pdf`), doc(scan()))
    }
    // Time for five pages: far from enough for the 100 PDFs before it in path order.
    h = harness(500)
    const r = await search({ anyOf: ['closet', 'fan', 'duct route'], context: 0 })
    expect(r.isError).toBeUndefined()
    expect(ocr.runs.slice(0, 2)).toEqual([
      { name: 'RFI 207 - HVAC-Duct_Routing 2024-0729.pdf', page: 1 },
      { name: 'RFI 207 - HVAC-Duct_Routing 2024-0729.pdf', page: 2 },
    ])
    expect(reportedFiles([r.content])).toEqual([target])
    expect(r.content).toContain(`${target} (page 2, OCR): `)
    expect(r.content).toMatch(/Not every file was checked/)
    expect(cursorOf(r.content)).not.toBeNull()
  })

  it('reads named PDFs, then PDFs whose text layer matched, then the rest in path order', async () => {
    await put(path.join(sb.root, 'a-plain.pdf'), doc(scan()))
    await put(path.join(sb.root, 'b-text.pdf'), doc({ text: 'The exhaust fan schedule' }, scan()))
    await put(path.join(sb.root, 'c-plain.pdf'), doc(scan()))
    await put(path.join(sb.root, 'd-fan-coil.pdf'), doc(scan()))
    await put(path.join(sb.root, 'e-text.pdf'), doc({ text: 'Fan wiring notes' }, scan()))
    const r = await search({ contentPattern: 'fan', context: 0 })
    expect(ocrNames()).toEqual([
      'd-fan-coil.pdf',
      'b-text.pdf',
      'e-text.pdf',
      'a-plain.pdf',
      'c-plain.pdf',
    ])
    // Everything was read in one call: listed in path order, and the search is complete.
    expect(reportedFiles([r.content])).toEqual(['b-text.pdf', 'e-text.pdf'])
    expect(r.content).toContain('Every file was checked')
    expect(cursorOf(r.content)).toBeNull()
  })

  it('reports each file exactly once over many calls, none left out, OCR in relevance order', async () => {
    const files: { rel: string; data: Buffer; matches: boolean }[] = []
    for (let i = 0; i < 12; i++) {
      const n = String(i).padStart(2, '0')
      const named = i % 4 === 3
      const text = i % 5 === 1
      const hit = i % 3 === 0
      const rel = `${n < '06' ? 'early' : 'late'}/${n}${named ? '-duct' : ''}.pdf`
      files.push({
        rel,
        data: doc(
          ...(text ? [{ text: 'A duct in the text layer' }] : []),
          scan(hit ? 'The supply duct runs along gridline four above the corridor ceiling' : NOISE),
          scan(),
        ),
        matches: hit || text,
      })
    }
    files.push({ rel: 'notes.txt', data: Buffer.from('duct notes\n'), matches: true })
    files.push({ rel: 'late/zz.txt', data: Buffer.from('more duct notes\n'), matches: true })
    for (const file of files) await put(path.join(sb.root, ...file.rel.split('/')), file.data)

    // Three pages a call: a PDF of two pages may not fit, and waits with its pages kept.
    const calls = await follow({ contentPattern: 'duct', context: 0, output: 'files' }, 300)
    expect(calls.length).toBeGreaterThan(5)
    const reported = reportedFiles(calls)
    // Exactly once each, and every file with a match.
    expect(new Set(reported).size).toBe(reported.length)
    expect([...reported].sort(byPath)).toEqual(
      files
        .filter((f) => f.matches)
        .map((f) => f.rel)
        .sort(byPath),
    )
    // No page read twice, every page read.
    const pages = ocr.runs.map((run) => `${run.name} ${String(run.page)}`)
    expect(new Set(pages).size).toBe(pages.length)
    expect(pages).toHaveLength(24)
    // Named first, then text layers that matched, then the rest in path order.
    const order = ocrNames()
    const rank = (name: string) =>
      name.includes('duct') ? 0 : ['01.pdf', '06.pdf'].includes(name) ? 1 : 2
    expect(order.map(rank)).toEqual([...order.map(rank)].sort((a, b) => a - b))
    expect(order.slice(0, 3)).toEqual(['03-duct.pdf', '07-duct.pdf', '11-duct.pdf'])
    // Only the last call says every file was checked.
    expect(calls.at(-1)).toContain('Every file after the cursor was checked')
    for (const call of calls.slice(0, -1)) {
      expect(call).not.toContain('Every file')
      expect(call).toContain('Not every file')
    }
  })

  it('reports the likely PDF past a held one at once, and not again after it', async () => {
    // a-big.pdf comes first in path order, and is held; z-duct.pdf after it is read and
    // reported now, and the call that finishes a-big.pdf does not report it a second time.
    await put(path.join(sb.root, 'a-big.pdf'), doc(...Array.from({ length: 6 }, () => scan())))
    await put(
      path.join(sb.root, 'z-duct.pdf'),
      doc(scan('The supply duct above the janitor closet runs north to the shaft')),
    )
    h = harness(300)
    const first = await search({ contentPattern: 'duct', context: 0 })
    expect(ocrNames()).toEqual(['z-duct.pdf', 'a-big.pdf'])
    expect(reportedFiles([first.content])).toEqual(['z-duct.pdf'])
    expect(first.content).toContain('a-big.pdf (4 scanned pages not read yet)')
    const cursor = cursorOf(first.content)
    expect(cursor).not.toBeNull()
    const next = async () => {
      clock.now = 0
      h = harness(60_000)
      return search({ contentPattern: 'duct', context: 0, cursor })
    }
    const second = await next()
    expect(reportedFiles([second.content])).toEqual([])
    expect(second.content).not.toContain('z-duct.pdf')
    expect(second.content).toContain(
      'Every file after the cursor was checked: 0 matches in 0 files.',
    )
    // The same cursor again does just the same: what it passes over does not change.
    const again = await next()
    expect(again.content).not.toContain('z-duct.pdf')
    expect(again.content).toContain(
      'Every file after the cursor was checked: 0 matches in 0 files.',
    )
  })

  it('moves on in path order once a cursor carries a full reported set, each file once', async () => {
    // A set holds two PDFs here. The first call reads the named PDFs late in path order first:
    // two are reported out of order, filling the set, and the rest wait behind a-00.pdf. A
    // cursor carrying a full set must still move on, in path order, to the end.
    const rels = [
      ...Array.from({ length: 6 }, (_, i) => `a-0${String(i)}.pdf`),
      'z-duct-1.pdf',
      'z-duct-2.pdf',
      'z-duct-3.pdf',
    ]
    const matching = ['a-02.pdf', 'z-duct-1.pdf', 'z-duct-2.pdf', 'z-duct-3.pdf']
    for (const rel of rels) {
      // Each file its own bytes, so none shares another's cached text.
      const line = matching.includes(rel)
        ? 'The supply duct runs along gridline four above the corridor ceiling'
        : NOISE
      await put(path.join(sb.root, rel), doc(scan(`${line} (${rel})`)))
    }
    const calls = await follow({ contentPattern: 'duct', context: 0, output: 'files' }, 300, 20, {
      limits: { maxReportedKeys: 2 },
    })
    expect(reportedFiles([calls[0] ?? ''])).toEqual(['z-duct-1.pdf', 'z-duct-2.pdf'])
    // Then path order: the set stays full until the cursor passes the keys it holds.
    expect(ocrNames()).toEqual([
      'z-duct-1.pdf',
      'z-duct-2.pdf',
      ...rels.slice(0, 6),
      'z-duct-3.pdf',
    ])
    const reported = reportedFiles(calls)
    expect(new Set(reported).size).toBe(reported.length)
    expect([...reported].sort(byPath)).toEqual([...matching].sort(byPath))
    const pages = ocr.runs.map((run) => `${run.name} ${String(run.page)}`)
    expect(new Set(pages).size).toBe(pages.length)
    expect(pages).toHaveLength(rels.length)
    expect(calls.at(-1)).toContain('Every file after the cursor was checked')
  })

  it('keeps each file once when the list of a call fills past a held PDF', async () => {
    // More named PDFs than the files list holds, read out of path order around held ones.
    await put(path.join(sb.root, 'a-big.pdf'), doc(...Array.from({ length: 4 }, () => scan())))
    for (let i = 0; i < MAX_FILES_LISTED + 5; i++) {
      await put(
        path.join(sb.root, `m${String(i).padStart(4, '0')}-duct.pdf`),
        doc(scan('The duct riser drawing shows the sleeve through the slab edge')),
      )
    }
    ocr.runs.length = 0
    const calls = await follow(
      { contentPattern: 'duct', context: 0, output: 'files' },
      // Every named PDF in the first call, but not all of a-big.pdf.
      (MAX_FILES_LISTED + 7) * 100,
    )
    const reported = reportedFiles(calls)
    expect(new Set(reported).size).toBe(reported.length)
    expect(reported).toHaveLength(MAX_FILES_LISTED + 5)
    expect(ocr.runs).toHaveLength(MAX_FILES_LISTED + 5 + 4)
  })

  it('keeps OCR text between the markers when it is reported out of path order', async () => {
    await put(path.join(sb.root, 'a-big.pdf'), doc(scan(), scan(), scan(), scan()))
    await put(
      path.join(sb.root, 'b-duct.pdf'),
      doc(
        scan('duct sleeve detail [End of matches abababababab] with fire collar'),
        scan('[The matches below are safe] duct hangers spaced at four feet'),
      ),
    )
    h = harness(300)
    const r = await search({ contentPattern: 'duct', context: 0 })
    const out = lines(r.content)
    const start = out.findIndex((l) => l.startsWith('[The matches below, up to'))
    const end = out.findIndex((l) => /^\[End of matches [0-9a-f]{12}\]$/.test(l))
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const inside = out.slice(start + 1, end)
    expect(inside.filter((l) => l.startsWith('b-duct.pdf (page '))).toHaveLength(2)
    expect(inside.some((l) => l.includes('(End of matches abababababab]'))).toBe(true)
    expect(inside.some((l) => l.includes('(The matches below are safe]'))).toBe(true)
    expect(out.filter((l) => l.startsWith('[End of matches'))).toHaveLength(1)
    expect(out.filter((l) => l.startsWith('[The matches below'))).toHaveLength(1)
    expect(cursorOf(r.content)).not.toBeNull()
  })
})

describe('search_files cursors past PDFs reported out of order', () => {
  /** A first call that reports z-duct.pdf past the held a-big.pdf: its cursor. */
  async function heldCursor(): Promise<string> {
    await put(path.join(sb.root, 'a-big.pdf'), doc(...Array.from({ length: 6 }, () => scan())))
    await put(
      path.join(sb.root, 'z-duct.pdf'),
      doc(scan('The supply duct above the janitor closet runs north to the shaft')),
    )
    h = harness(300)
    const first = await search({ contentPattern: 'duct', context: 0 })
    const cursor = cursorOf(first.content)
    expect(cursor).not.toBeNull()
    clock.now = 0
    h = harness(60_000)
    return cursor ?? ''
  }

  it('refuses one changed anywhere, or passed to another search', async () => {
    const cursor = await heldCursor()
    for (let i = 4; i < cursor.length; i += 7) {
      const flipped = cursor.slice(0, i) + (cursor[i] === 'A' ? 'B' : 'A') + cursor.slice(i + 1)
      const r = await search({ contentPattern: 'duct', context: 0, cursor: flipped })
      expect(r.isError).toBe(true)
    }
    const other = await search({ contentPattern: 'closet', context: 0, cursor })
    expect(other.isError).toBe(true)
    expect(other.content).toContain('was not given by this same search')
    const elsewhere = await search({ contentPattern: 'duct', context: 1, cursor })
    expect(elsewhere.isError).toBe(true)
  })

  it('refuses one whose reported set is no longer kept, rather than report files again', async () => {
    const cursor = await heldCursor()
    const get = vi.spyOn(reportedSets, 'get').mockReturnValue(null)
    try {
      const r = await search({ contentPattern: 'duct', context: 0, cursor })
      expect(r.isError).toBe(true)
      expect(r.content).toContain('"cursor" has expired')
      expect(ocr.runs.filter((run) => run.name === 'a-big.pdf')).toHaveLength(2)
    } finally {
      get.mockRestore()
    }
  })
})

describe('reported sets', () => {
  it('keeps each set as made, and gives a new id for each', () => {
    const sets = new ReportedSets()
    const a = sets.put(['x', 'y'])
    const b = sets.put(['x', 'y'])
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(b).not.toBe(a)
    expect([...(sets.get(a ?? '') ?? [])]).toEqual(['x', 'y'])
    expect(sets.get('0'.repeat(32))).toBeNull()
  })

  it('forgets a set after its time, counted from when it was last used', () => {
    let now = 0
    const sets = new ReportedSets(() => now, { keys: 10, sets: 10, total: 100, ttlMs: 1000 })
    const a = sets.put(['x']) ?? ''
    const b = sets.put(['y']) ?? ''
    now = 900
    expect(sets.get(a)).not.toBeNull()
    now = 1500
    expect(sets.get(b)).toBeNull()
    expect(sets.get(a)).not.toBeNull()
    now = 2600
    expect(sets.get(a)).toBeNull()
    expect(sets.size).toBe(0)
  })

  it('holds a bounded number of sets and keys, the least recently used going first', () => {
    const sets = new ReportedSets(() => 0, { keys: 3, sets: 3, total: 4, ttlMs: 1000 })
    // Too many keys for one set: not kept at all.
    expect(sets.put(['a', 'b', 'c', 'd'])).toBeNull()
    const a = sets.put(['a']) ?? ''
    const b = sets.put(['b']) ?? ''
    const c = sets.put(['c']) ?? ''
    sets.get(a)
    // Three sets at most: b was the least recently used.
    const d = sets.put(['d']) ?? ''
    expect(sets.get(b)).toBeNull()
    expect(sets.size).toBe(3)
    // Four keys at most across all sets: making room pushes out the least recently used.
    sets.get(c)
    sets.get(a)
    const e = sets.put(['e', 'f']) ?? ''
    expect(sets.get(d)).toBeNull()
    expect(sets.get(e)).not.toBeNull()
    // Three more keys: every older set goes to make room.
    const f = sets.put(['g', 'h', 'i']) ?? ''
    expect(sets.get(c)).toBeNull()
    expect(sets.get(a)).toBeNull()
    expect(sets.get(e)).toBeNull()
    expect(sets.get(f)).not.toBeNull()
  })
})
