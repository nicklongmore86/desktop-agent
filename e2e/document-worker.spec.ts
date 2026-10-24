import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { readExif } from '../src/main/documents/exif'
import {
  jpegShell,
  makeExif,
  makePdf,
  makeZip,
  pngShell,
  withExif,
} from '../src/main/documents/fixtures.test-util'
import { imageDimensions } from '../src/main/documents/limits'
import {
  grid,
  hostileOle,
  makeDoc,
  makeDocx,
  makeOdp,
  makeOdt,
  makePpt,
  makePptx,
  makeWorkbook,
  wp,
  wtbl,
} from '../src/main/documents/office-fixtures.test-util'
import type { DocumentView, ExtractOptions } from '../src/main/documents/types'

/**
 * The document reader in real Electron: the built host (out/main/documents.js) starts its
 * hidden, sandboxed worker window (out/document-worker) and parses with PDFium WASM and
 * Chromium's image codecs. Covers a small PDF (text, a rendered page, a region), a
 * rotated JPEG with EXIF (orientation applied, EXIF stripped, GPS only when asked), Word,
 * Excel, PowerPoint and OpenDocument files (SheetJS and the XML readers inside the
 * worker, hostile ones included), the malformed corpus, and the timeout kill.
 */

type Pixel = { r: number; g: number; b: number }
type SerialisedImage = Omit<DocumentView['images'][number], 'bytes'> & {
  bytes: string
  decodedSize: { width: number; height: number }
  top: Pixel
  bottom: Pixel
}
type Result =
  | (Omit<DocumentView, 'images'> & { images: SerialisedImage[]; error?: undefined })
  | { error: { name: string; code: string; message: string } }

interface Harness {
  extract: (base64: string, options: ExtractOptions) => Promise<Result>
  stats: () => { workersStarted: number; jobs: number; lastStartMs: number }
  makeJpeg: (width: number, height: number) => string
  makeNoise: (width: number, height: number) => string
  ticks: () => number
  alive: () => { brokers: number; windows: number }
}

async function launch(hostOptions: Record<string, unknown> = {}): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/documents-main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_DOCUMENT_HOST: JSON.stringify(hostOptions) },
  })
  await app.evaluate(async ({ app: electronApp }) => {
    await electronApp.whenReady()
    while (!(globalThis as { documents?: unknown }).documents) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
  return app
}

const docs = (app: ElectronApplication) => ({
  extract: (bytes: Uint8Array, options: ExtractOptions = {}): Promise<Result> =>
    app.evaluate(
      (_electron, [base64, opts]) =>
        (globalThis as unknown as { documents: Harness }).documents.extract(base64, opts),
      [Buffer.from(bytes).toString('base64'), options] as const,
    ),
  stats: () =>
    app.evaluate(() => (globalThis as unknown as { documents: Harness }).documents.stats()),
  ticks: () =>
    app.evaluate(() => (globalThis as unknown as { documents: Harness }).documents.ticks()),
  alive: () =>
    app.evaluate(() => (globalThis as unknown as { documents: Harness }).documents.alive()),
  makeJpeg: async (width: number, height: number): Promise<Uint8Array> =>
    Buffer.from(
      await app.evaluate(
        (_electron, [w, h]) =>
          (globalThis as unknown as { documents: Harness }).documents.makeJpeg(w, h),
        [width, height] as const,
      ),
      'base64',
    ),
})

function ok(result: Result): Exclude<Result, { error: object }> {
  if (result.error) throw new Error(`refused: ${result.error.code} ${result.error.message}`)
  return result
}

const imageBytes = (image: SerialisedImage | undefined): Uint8Array =>
  new Uint8Array(Buffer.from(image?.bytes ?? '', 'base64'))

test.describe('document worker (real Electron)', () => {
  let app: ElectronApplication
  test.beforeAll(async () => {
    app = await launch()
  })
  test.afterAll(async () => {
    await app.close()
  })

  test('PDF: text per page, a rendered drawing page, and a zoomed region', async () => {
    const pdf = makePdf([
      { text: ['Site survey', 'Ground floor plan follows on the next page.'] },
      { drawing: true },
    ])
    const view = ok(await docs(app).extract(pdf, { name: 'survey.pdf' }))
    expect(view.meta).toMatchObject({ kind: 'pdf', pageCount: 2, name: 'survey.pdf' })
    expect(view.sections[0]).toEqual({
      page: 1,
      text: 'Site survey\nGround floor plan follows on the next page.',
    })
    expect(view.images).toHaveLength(1)
    const [page] = view.images
    expect(page).toMatchObject({
      mime: 'image/png',
      width: 1212,
      height: 1568,
      source: { page: 2 },
    })
    expect(imageDimensions(imageBytes(page), 'png')).toEqual({ width: 1212, height: 1568 })
    expect(page?.decodedSize).toEqual({ width: 1212, height: 1568 })

    const region = { page: 2, x: 0.15, y: 0.2, width: 0.25, height: 0.25 }
    const zoomed = ok(await docs(app).extract(pdf, { select: { region } }))
    expect(zoomed.images).toHaveLength(1)
    expect(zoomed.images[0]).toMatchObject({
      width: 1212,
      height: 1568,
      source: { page: 2, region },
    })
    // The region is grid lines on white: some pixels must be the drawing's blue.
    const blue = (p: Pixel | undefined) => !!p && p.b > 150 && p.r < 100
    const white = (p: Pixel | undefined) => !!p && p.r > 240 && p.g > 240 && p.b > 240
    const samples = [zoomed.images[0]?.top, zoomed.images[0]?.bottom]
    expect(samples.every((p) => blue(p) || white(p))).toBe(true)
    expect(imageBytes(zoomed.images[0]).length).toBeGreaterThan(5_000)
  })

  test('the worker page has no Node, no network and no files outside its own', async () => {
    ok(await docs(app).extract(makePdf([{ text: ['warm up'] }]), { view: 'text' }))
    const probe = await app.evaluate(async ({ BrowserWindow }) => {
      const [worker] = BrowserWindow.getAllWindows()
      if (!worker) return null
      return {
        visible: worker.isVisible(),
        sandboxed: (
          worker.webContents as unknown as {
            getLastWebPreferences: () => { sandbox?: boolean } | null
          }
        ).getLastWebPreferences()?.sandbox,
        page: (await worker.webContents.executeJavaScript(`(async () => {
          const attempt = (run) => run().then(() => 'allowed', () => 'blocked')
          return {
            node: typeof require + ' ' + typeof process,
            fetch: await attempt(() => fetch('https://example.com/')),
            outside: await attempt(() => import('../renderer/index.html')),
          }
        })()`)) as unknown,
      }
    })
    expect(probe).toEqual({
      visible: false,
      sandboxed: true,
      page: { node: 'undefined undefined', fetch: 'blocked', outside: 'blocked' },
    })
  })

  test('rotated JPEG: orientation applied, EXIF stripped, GPS only when asked', async () => {
    // Stored 400x200, left red / right blue. Orientation 6 = rotate 90° clockwise to view:
    // upright it is 200x400 with red on top.
    const stored = await docs(app).makeJpeg(400, 200)
    const photo = withExif(
      stored,
      makeExif({
        orientation: 6,
        make: 'Canon',
        model: 'EOS R6',
        dateTimeOriginal: '2026:07:14 09:30:12',
        gps: { lat: 51.5007, latRef: 'N', lon: 0.1246, lonRef: 'W' },
      }),
    )
    expect(readExif(photo, 'jpeg')?.orientation).toBe(6)

    const view = ok(await docs(app).extract(photo, { name: 'IMG_0001.jpg' }))
    expect(view.meta).toMatchObject({ kind: 'jpeg', width: 200, height: 400 })
    const [image] = view.images
    expect(image).toMatchObject({ mime: 'image/jpeg', width: 200, height: 400 })
    expect(image?.top.r).toBeGreaterThan(200)
    expect(image?.top.b).toBeLessThan(60)
    expect(image?.bottom.b).toBeGreaterThan(200)
    expect(image?.bottom.r).toBeLessThan(60)
    const output = imageBytes(image)
    expect(imageDimensions(output, 'jpeg')).toEqual({ width: 200, height: 400 })
    expect(readExif(output, 'jpeg')).toBeNull()
    expect(Buffer.from(output).includes(Buffer.from('Exif\0\0'))).toBe(false)

    const text = view.sections[0]?.text ?? ''
    expect(text).toContain('Captured: 2026:07:14 09:30:12')
    expect(text).toContain('Camera: Canon EOS R6')
    expect(text).not.toContain('51.5')
    const located = ok(await docs(app).extract(photo, { includeLocation: true }))
    expect(located.sections[0]?.text).toMatch(/Location: 51\.50\d*, -0\.12\d*/)
  })

  test('downscales a large image to the requested long edge', async () => {
    const big = await docs(app).makeJpeg(3000, 1000)
    const view = ok(await docs(app).extract(big, { budget: { longEdge: 600 } }))
    expect(view.images[0]).toMatchObject({ width: 600, height: 200 })
  })

  test('keeps every returned image under 5 MB, however noisy', async () => {
    const noise = Buffer.from(
      await app.evaluate(
        (_electron, [w, h]) =>
          (globalThis as unknown as { documents: Harness }).documents.makeNoise(w, h),
        [3000, 3000] as const,
      ),
      'base64',
    )
    const view = ok(await docs(app).extract(noise, { budget: { longEdge: 3000 } }))
    const [image] = view.images
    const bytes = imageBytes(image)
    expect(bytes.length).toBeLessThanOrEqual(5 * 1024 * 1024)
    // PNG would be far over 5 MB, so it came back as JPEG, smaller if it had to.
    expect(image?.mime).toBe('image/jpeg')
    expect(imageDimensions(bytes, 'jpeg')).toEqual({ width: image?.width, height: image?.height })
  })

  test('Office and OpenDocument files are read inside the worker', async () => {
    const docx = ok(
      await docs(app).extract(
        makeDocx(
          wp('Plan', { style: 'Heading1' }) +
            wp('Buy milk', { list: 1 }) +
            wtbl([
              ['a', 'b'],
              ['1', '2'],
            ]),
        ),
        { name: 'plan.docx' },
      ),
    )
    expect(docx.meta).toMatchObject({ kind: 'docx', title: 'Plan', name: 'plan.docx' })
    expect(docx.sections[0]?.text).toBe(
      '# Plan\n\n- Buy milk\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
    )

    const book = makeWorkbook({ Data: grid(100, 4), Other: [['x']] })
    const listing = ok(await docs(app).extract(book))
    expect(listing.meta.sheets).toEqual([
      { name: 'Data', used: 'A1:D100' },
      { name: 'Other', used: 'A1' },
    ])
    expect(listing.sections[0]?.sheet).toEqual({
      name: 'Data',
      shown: 'A1:D20',
      used: 'A1:D100',
      next: 'A21:D100',
    })
    const range = ok(await docs(app).extract(book, { select: { range: 'Data!B90:C' } }))
    expect(range.sections[0]?.sheet).toMatchObject({ shown: 'B90:C100' })
    expect(range.sections[0]?.text).toContain('| 100 | B100 | C100 |')
    for (const type of ['biff8', 'ods'] as const) {
      const other = ok(await docs(app).extract(makeWorkbook({ Data: grid(3, 2) }, type)))
      expect(other.sections[0]?.text, type).toContain('| 3 | A3 | B3 |')
    }
    const csv = ok(
      await docs(app).extract(new TextEncoder().encode('a,b\n1,2\n'), { name: 'x.csv' }),
    )
    expect(csv.meta.kind).toBe('csv')

    const deck = ok(
      await docs(app).extract(
        makePptx([{ title: 'Hi', body: ['One'], notes: 'Smile' }, { title: 'Two' }]),
      ),
    )
    expect(deck.position).toEqual({
      unit: 'slide',
      total: 2,
      shown: { from: 1, to: 2 },
      next: null,
    })
    expect(deck.sections[0]?.text).toBe('# Hi\nOne\n\nSpeaker notes:\nSmile')

    const odt = ok(
      await docs(app).extract(
        makeOdt('<text:h text:outline-level="1">Notes</text:h><text:p>Body</text:p>'),
      ),
    )
    expect(odt.sections[0]?.text).toBe('# Notes\n\nBody')
    const odp = ok(
      await docs(app).extract(
        makeOdp(
          '<draw:page><draw:custom-shape><text:p>Slide text</text:p></draw:custom-shape></draw:page>',
        ),
      ),
    )
    expect(odp.sections[0]?.text).toBe('Slide text')
    const doc = ok(await docs(app).extract(makeDoc('Old Word text\r', 'and more\r')))
    expect(doc.sections[0]?.text).toBe('Old Word text\nand more')
    expect((await docs(app).extract(makePpt())).error?.code).toBe('unsupported')
  })

  test('hostile Office files are refused inside the worker, which stays healthy', async () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    const lol = Array.from(
      { length: 9 },
      (_, i) => `<!ENTITY l${String(i + 1)} "${`&l${String(i)};`.repeat(10)}">`,
    ).join('')
    let deep = wp('core')
    for (let i = 0; i < 100; i++) deep = wtbl([[{ xml: deep }]])
    const corpus: [string, Uint8Array, string][] = [
      [
        'XXE',
        makeDocx('', {
          document: `<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`,
        }),
        'malformed',
      ],
      [
        'billion laughs',
        makeDocx('', {
          document: `<!DOCTYPE d [<!ENTITY l0 "lol">${lol}]><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&l9;</w:t></w:r></w:p></w:body></w:document>`,
        }),
        'malformed',
      ],
      ['nested tables', makeDocx(deep), 'malformed'],
      [
        'zip bomb',
        makeZip([
          { name: '[Content_Types].xml', data: '<Types/>' },
          { name: 'word/document.xml', data: new Uint8Array(64 * 1024 * 1024) },
        ]),
        'zip-bomb',
      ],
      [
        'lying entry',
        makeZip([
          { name: '[Content_Types].xml', data: '<Types/>' },
          {
            name: 'xl/workbook.xml',
            data: `<workbook>${' '.repeat(8 * 1024 * 1024)}</workbook>`,
            declaredSize: 100,
          },
        ]),
        'zip-bomb',
      ],
      ['OLE FAT loop', hostileOle.fatLoop(), 'malformed'],
      ['OLE DIFAT loop', hostileOle.difatLoop(), 'malformed'],
      ['OLE huge declared stream', hostileOle.hugeStream(), 'zip-bomb'],
      ['OLE directory cycle', hostileOle.directoryCycle(), 'malformed'],
      ['OLE truncated', hostileOle.truncated(), 'malformed'],
      ['OLE tangled FAT', hostileOle.tangledFat(), 'malformed'],
    ]
    for (const [label, bytes, code] of corpus) {
      const started = Date.now()
      const result = await docs(app).extract(bytes)
      expect(result.error?.code, label).toBe(code)
      expect(Date.now() - started, label).toBeLessThan(10_000)
    }
    ok(await docs(app).extract(makeDocx(wp('fine'))))
  })

  test('malformed corpus is refused without hanging', async () => {
    const corpus: [string, Uint8Array, string][] = [
      ['encrypted PDF', makePdf([{ text: ['x'] }], { encrypted: true }), 'password-protected'],
      ['truncated PDF', makePdf([{ text: ['x'] }]).slice(0, 40), 'malformed'],
      ['oversized PNG', pngShell(60_000, 60_000), 'too-many-pixels'],
      ['garbage', new Uint8Array(2048).map((_, i) => (i * 7919) % 251), 'unsupported'],
    ]
    for (const [label, bytes, code] of corpus) {
      const started = Date.now()
      const result = await docs(app).extract(bytes)
      expect(result.error?.code, label).toBe(code)
      expect(Date.now() - started, label).toBeLessThan(10_000)
    }
    // A JPEG header promising pixels it does not have: decodes to nothing, says so.
    const hollow = ok(await docs(app).extract(jpegShell(64, 64)))
    expect(hollow.images).toHaveLength(0)
    expect(hollow.warnings).toContain('The JPEG image could not be decoded here.')
    // Still healthy afterwards.
    ok(await docs(app).extract(makePdf([{ text: ['fine'] }])))
  })
})

test('a job past the timeout is refused and its worker window destroyed', async () => {
  const app = await launch({ timeoutMs: 5 })
  try {
    const heavy = makePdf(Array.from({ length: 20 }, () => ({ drawing: true })))
    const result = await docs(app).extract(heavy, { view: 'images', budget: { maxImages: 20 } })
    expect(result.error?.code).toBe('timeout')
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(windows).toBe(0)
    expect((await docs(app).stats()).workersStarted).toBe(1)
  } finally {
    await app.close()
  }
})

test('workers are recycled after N jobs and start quickly', async () => {
  const app = await launch({ maxJobsPerWorker: 2 })
  try {
    const pdf = makePdf([{ text: ['one page'] }])
    for (let i = 0; i < 3; i++) ok(await docs(app).extract(pdf, { view: 'text' }))
    const stats = await docs(app).stats()
    expect(stats).toMatchObject({ workersStarted: 2, jobs: 3 })
    // Roughly 150 ms on a developer machine; CI runners are slower.
    expect(stats.lastStartMs).toBeLessThan(5_000)
  } finally {
    await app.close()
  }
})

test.describe('a hostile worker (a compromised page speaking the protocol)', () => {
  let app: ElectronApplication
  test.beforeAll(async () => {
    app = await launch({ hostile: true, timeoutMs: 15_000 })
  })
  test.afterAll(async () => {
    await app.close()
  })

  for (const attack of ['transfer', 'huge', 'many-images', 'flood', 'garbage']) {
    test(`'${attack}' fails the job and kills the worker, main never stalls, the next job works`, async () => {
      const d = docs(app)
      const ticksBefore = await d.ticks()
      const started = Date.now()
      const result = await d.extract(new TextEncoder().encode('hello'), { name: attack })
      const elapsed = Date.now() - started
      const ticks = (await d.ticks()) - ticksBefore
      expect(result.error?.code).toBe('worker-failed')
      // Killed by the broker's checks or its crash, not by the 15 s timeout.
      expect(elapsed).toBeLessThan(10_000)
      // Main's 10 ms timer kept running throughout (generously: a quarter of the turns).
      expect(ticks).toBeGreaterThanOrEqual(Math.floor(elapsed / 10 / 4))
      await expect.poll(() => d.alive(), { timeout: 5_000 }).toEqual({ brokers: 0, windows: 0 })

      const next = ok(await d.extract(new TextEncoder().encode('hello'), { name: 'ok' }))
      expect(next.sections).toEqual([{ text: 'fine' }])
      expect(await d.alive()).toEqual({ brokers: 1, windows: 1 })
    })
  }
})
