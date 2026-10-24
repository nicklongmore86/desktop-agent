import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import { promises as fs, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractDocument } from '../documents/extract'
import { makePdf } from '../documents/fixtures.test-util'
import { DEFAULT_LIMITS } from '../documents/limits'
import {
  DocumentError,
  type DocumentReader,
  type DocumentView,
  type ExtractOptions,
} from '../documents/types'
import {
  fakeContext,
  makeSandbox,
  put,
  trySymlink,
  type Sandbox,
} from '../permissions/test-support'
import { toolHarness, type ToolHarness } from './test-support'

/** A stand-in for DocumentWorkerHost: answers with `answer`, records what it was asked. */
function fakeReader(answer: (bytes: Uint8Array, options: ExtractOptions) => DocumentView) {
  const calls: { bytes: Uint8Array; options: ExtractOptions }[] = []
  const reader: DocumentReader = {
    extract: vi.fn((bytes: Uint8Array, options: ExtractOptions = {}) => {
      calls.push({ bytes, options })
      return new Promise<DocumentView>((resolve) => {
        resolve(answer(bytes, options))
      })
    }),
  }
  return { reader, calls }
}

const png = (bytes = [0x89, 0x50]) => new Uint8Array(bytes)

function pdfView(over: Partial<DocumentView> = {}): DocumentView {
  return {
    meta: { kind: 'pdf', mime: 'application/pdf', pageCount: 40, title: 'Site plan' },
    sections: [
      { page: 1, text: 'Introduction\nThe site is 2 ha.' },
      { page: 2, text: '' },
    ],
    images: [{ bytes: png(), mime: 'image/png', width: 1212, height: 1568, source: { page: 2 } }],
    position: { unit: 'page', total: 40, shown: { from: 1, to: 2 }, next: 3 },
    warnings: [],
    ...over,
  }
}

function photoView(location: boolean): DocumentView {
  return {
    meta: { kind: 'jpeg', mime: 'image/jpeg', width: 3024, height: 4032 },
    sections: [
      {
        title: 'Image metadata',
        text:
          'Captured: 2026:05:01 10:00:00\nCamera: Pixel 9\n' +
          (location
            ? 'Location: 51.5, -0.12'
            : 'Location: recorded (not included; ask with include_location)'),
      },
    ],
    images: [
      { bytes: png([0xff, 0xd8]), mime: 'image/jpeg', width: 1176, height: 1568, source: {} },
    ],
    position: { unit: 'image', total: 1, shown: { from: 1, to: 1 }, next: null },
    warnings: [],
  }
}

let sb: Sandbox
let h: ToolHarness

beforeEach(async () => {
  sb = await makeSandbox()
})

afterEach(async () => {
  await sb.cleanup()
})

const run = (input: unknown) => h.tool('read_document').execute(input, fakeContext().ctx)

describe('read_document', () => {
  it('returns the pages as text, drawn pages as images, and where to continue', async () => {
    const { reader, calls } = fakeReader(() => pdfView())
    h = toolHarness(sb, { documents: reader })
    const file = path.join(sb.root, 'plan.pdf')
    const bytes = makePdf([{ text: ['Introduction'] }, { drawing: true }])
    await put(file, Buffer.from(bytes))

    const r = await run({ path: file })
    expect(r.isError).toBeUndefined()
    expect(r.content.split('\n')).toEqual([
      `[${file} | PDF | ${(bytes.length / 1024).toFixed(1)} KB | 40 pages | pages 1-2 shown | title: Site plan]`,
      '--- Page 1 ---',
      'Introduction',
      'The site is 2 ha.',
      '--- Page 2 (little or no text; attached as image 1) ---',
      '[More: pages 3-40 not shown. Call read_document with start: 3 to continue.]',
    ])
    expect(r.images).toEqual([
      { mime: 'image/png', data: png(), width: 1212, height: 1568, label: 'page 2' },
    ])
    // The worker gets a copy of the file's bytes, never its path.
    expect(calls).toHaveLength(1)
    expect(Buffer.from(calls[0]?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true)
    expect(calls[0]?.options).toEqual({ name: 'plan.pdf' })
    expect(h.audit.entries).toEqual([
      expect.objectContaining({
        tool: 'read_document',
        args: { path: file, extra: { kind: 'pdf', imageCount: 1 } },
        paths: [file],
        approval: 'auto',
        origin: 'agent',
        outcome: 'ok',
      }),
    ])
  })

  it('passes page ranges, continuations and regions to the reader', async () => {
    const { reader, calls } = fakeReader(() => pdfView())
    h = toolHarness(sb, { documents: reader })
    const file = path.join(sb.root, 'plan.pdf')
    await put(file, Buffer.from(makePdf([{ text: ['x'] }])))

    await run({ path: file, pages: '2-5' })
    await run({ path: file, pages: '7' })
    await run({ path: file, pages: '10-' })
    await run({ path: file, start: 13 })
    const region = { page: 2, x: 0.5, y: 0.25, width: 0.5, height: 0.25 }
    const zoomed = await run({ path: file, region })
    expect(calls.map((call) => call.options.select)).toEqual([
      { from: 2, to: 5 },
      { from: 7, to: 7 },
      { from: 10 },
      { from: 13 },
      { region },
    ])
    expect(zoomed.content.split('\n')[0]).toContain(
      'page 2 region x=0.5 y=0.25 width=0.5 height=0.25',
    )
    expect(zoomed.images?.[0]?.label).toBe('page 2')
    expect(h.audit.entries.map((entry) => entry.args)).toEqual([
      expect.objectContaining({ from: 2, to: 5 }),
      expect.objectContaining({ from: 7, to: 7 }),
      expect.objectContaining({ from: 10 }),
      expect.objectContaining({ start: 13 }),
      expect.objectContaining({ region }),
    ])
  })

  it('labels a zoomed region and says when it has no text', async () => {
    const region = { page: 3, x: 0, y: 0, width: 0.5, height: 0.5 }
    const { reader } = fakeReader(() =>
      pdfView({
        sections: [],
        images: [
          {
            bytes: png(),
            mime: 'image/png',
            width: 1568,
            height: 1568,
            source: { page: 3, region },
          },
        ],
        position: { unit: 'page', total: 40, shown: { from: 3, to: 3 }, next: null },
      }),
    )
    h = toolHarness(sb, { documents: reader })
    const file = path.join(sb.root, 'plan.pdf')
    await put(file, Buffer.from(makePdf([{ drawing: true }])))
    const r = await run({ path: file, region })
    expect(r.content).toContain('[Image 1: page 3, the region above, at 1568 x 1568 px]')
    expect(r.content).toContain('[No text in this region.]')
    expect(r.images?.[0]?.label).toBe('page 3, zoomed region')
  })

  it('refuses bad ranges and regions before reading anything', async () => {
    const { reader, calls } = fakeReader(() => pdfView())
    h = toolHarness(sb, { documents: reader })
    const file = path.join(sb.root, 'plan.pdf')
    await put(file, Buffer.from(makePdf([{ text: ['x'] }])))
    const bad: unknown[] = [
      { path: file, pages: 'all' },
      { path: file, pages: '5-2' },
      { path: file, pages: '0' },
      { path: file, pages: '2', start: 3 },
      { path: file, start: 0 },
      { path: file, region: { page: 1, x: 0.6, y: 0, width: 0.6, height: 1 } },
      { path: file, region: { page: 1, x: 0, y: 0, width: 0, height: 1 } },
      { path: file, region: { page: 1, x: 0, y: 0, width: 1 } },
      { path: file, region: [1, 2] },
      { path: file, include_location: 'yes' },
    ]
    for (const input of bad) {
      expect(await run(input), JSON.stringify(input)).toMatchObject({
        isError: true,
        content: expect.stringMatching(/^Invalid input/) as unknown,
      })
    }
    expect(calls).toHaveLength(0)
  })

  describe('region zoom, through the real PDF reader', () => {
    let pdfium: WrappedPdfiumModule

    beforeAll(async () => {
      const require = createRequire(import.meta.url)
      const wasm = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
      pdfium = await init({
        wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length),
      })
      pdfium.PDFiumExt_Init()
    })

    /** extractDocument with real PDFium; the codecs only report the raster size. */
    const realReader = (): DocumentReader => ({
      extract: (bytes, options = {}) =>
        extractDocument(bytes, options, {
          pdfium: () => Promise.resolve(pdfium),
          encode: (_rgba, width, height) =>
            Promise.resolve({ bytes: png(), mime: 'image/png' as const, width, height }),
          decodeImage: () => Promise.reject(new Error('not used')),
        }),
    })

    // A 784 pt square page: a region w wide is drawn at 1568 / (784 w) times its natural size.
    beforeEach(async () => {
      h = toolHarness(sb, { documents: realReader() })
      await put(
        path.join(sb.root, 'square.pdf'),
        Buffer.from(makePdf([{ width: 784, height: 784, drawing: true }])),
      )
    })

    const zoom = async (size: number) => {
      const region = { page: 1, x: 0.25, y: 0.25, width: size, height: size }
      const r = await run({ path: path.join(sb.root, 'square.pdf'), region })
      expect(r.isError).toBeUndefined()
      expect(r.images).toHaveLength(1)
      return r
    }

    it(`zooms a region to exactly ${String(DEFAULT_LIMITS.maxRegionScale)}x`, async () => {
      expect(DEFAULT_LIMITS.maxRegionScale).toBe(8)
      // 196 pt across, drawn 1568 px across: 8x.
      const r = await zoom(0.25)
      expect(r.images?.[0]).toMatchObject({ width: 1568, height: 1568 })
      expect(r.content).toContain('at 1568 x 1568 px')
    })

    it('caps a region that would need more than 8x at 8x', async () => {
      // 98 pt across would need 16x to fill 1568 px; it is drawn at 8x, 784 px.
      const r = await zoom(0.125)
      expect(r.images?.[0]).toMatchObject({ width: 784, height: 784 })
      expect(r.content).toContain('at 784 x 784 px')
      // A tiny region stays at 8x too, never stretched further.
      const tiny = await zoom(0.01)
      expect(tiny.images?.[0]).toMatchObject({ width: 63, height: 63 })
    })
  })

  it('returns a photo upright with its facts as text, and its location only when asked', async () => {
    const { reader, calls } = fakeReader((_bytes, options) =>
      photoView(options.includeLocation === true),
    )
    h = toolHarness(sb, { documents: reader })
    const file = path.join(sb.root, 'IMG_0001.jpg')
    await put(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))

    const plain = await run({ path: file })
    expect(plain.content).toContain('Camera: Pixel 9')
    expect(plain.content).toContain('Location: recorded (not included; ask with include_location)')
    expect(plain.content).not.toContain('51.5')
    expect(plain.content).toContain(
      '[Image 1: the picture, upright, at 1176 x 1568 px, with its metadata removed]',
    )
    expect(plain.content.split('\n')[0]).toContain('JPEG image | 4 B | 3024 x 4032 px')
    expect(plain.images).toEqual([
      { mime: 'image/jpeg', data: png([0xff, 0xd8]), width: 1176, height: 1568, label: 'image' },
    ])
    expect(calls[0]?.options.includeLocation).toBeUndefined()

    const located = await run({ path: file, include_location: true })
    expect(located.content).toContain('Location: 51.5, -0.12')
    expect(calls[1]?.options.includeLocation).toBe(true)

    // The audit log records that the location was asked for and actually read.
    expect(h.audit.entries.map((entry) => entry.args)).toEqual([
      { path: file, extra: { kind: 'jpeg', imageCount: 1 } },
      {
        path: file,
        includeLocation: true,
        extra: { kind: 'jpeg', imageCount: 1, locationRead: true },
      },
    ])
  })

  it('records an asked-for location as not read when the photo has none', async () => {
    const { reader } = fakeReader(() => ({
      ...photoView(false),
      sections: [{ title: 'Image metadata', text: 'Camera: Pixel 9' }],
    }))
    h = toolHarness(sb, { documents: reader })
    const file = path.join(sb.root, 'a.jpg')
    await put(file, Buffer.from([0xff, 0xd8, 0xff]))
    await run({ path: file, include_location: true })
    expect(h.audit.entries[0]?.args).toEqual({
      path: file,
      includeLocation: true,
      extra: { kind: 'jpeg', imageCount: 1 },
    })
  })

  it('says clearly what is not supported yet', async () => {
    const answers: Record<string, DocumentView> = {
      'report.docx': {
        ...pdfView({ sections: [], images: [] }),
        meta: {
          kind: 'docx',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        warnings: ['Reading a Word document is not supported yet.'],
      },
      'IMG.heic': {
        ...pdfView({ sections: [], images: [] }),
        meta: { kind: 'heic', mime: 'image/heic' },
        warnings: [
          'HEIC/HEIF images are not supported yet. Convert it to JPEG or PNG and try again.',
        ],
      },
    }
    const { reader } = fakeReader((_bytes, options) => answers[options.name ?? ''] ?? pdfView())
    h = toolHarness(sb, { documents: reader })
    for (const name of Object.keys(answers)) {
      await put(path.join(sb.root, name), 'PK')
      const r = await run({ path: path.join(sb.root, name) })
      expect(r).toMatchObject({
        isError: true,
        content: expect.stringMatching(/not supported yet/) as unknown,
      })
      expect(r.images).toBeUndefined()
    }
    expect(h.audit.entries.map((entry) => entry.error)).toEqual(['unsupported', 'unsupported'])
  })

  it('points text files to read_file', async () => {
    const { reader } = fakeReader(() => ({
      ...pdfView({ sections: [{ text: 'hi' }], images: [] }),
      meta: { kind: 'text', mime: 'text/plain' },
    }))
    h = toolHarness(sb, { documents: reader })
    await put(path.join(sb.root, 'a.txt'), 'hi')
    expect(await run({ path: path.join(sb.root, 'a.txt') })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/use read_file/) as unknown,
    })
  })

  it('turns reader refusals and worker failures into clean errors', async () => {
    const failures: [Error, RegExp, string][] = [
      [
        new DocumentError('password-protected', 'The PDF is password-protected.'),
        /password-protected/,
        'unreadable',
      ],
      [
        new DocumentError('timeout', 'Reading the document took longer than 30 seconds.'),
        /30 seconds/,
        'timeout',
      ],
      [new DocumentError('out-of-range', 'Page 99 is past the end.'), /Page 99/, 'out-of-range'],
      [
        new DocumentError('worker-failed', 'The document reader stopped unexpectedly.'),
        /stopped/,
        'worker-failed',
      ],
      [new Error('boom: /secret/internal/path'), /the document reader failed/, 'worker-failed'],
    ]
    let next = 0
    const { reader } = fakeReader(() => {
      throw failures[next++]?.[0] ?? new Error('unexpected')
    })
    h = toolHarness(sb, { documents: reader })
    const file = path.join(sb.root, 'a.pdf')
    await put(file, Buffer.from(makePdf([{ text: ['x'] }])))
    for (const [, message] of failures) {
      const r = await run({ path: file })
      expect(r).toMatchObject({ isError: true, content: expect.stringMatching(message) as unknown })
      expect(r.content).not.toContain('/secret/internal')
    }
    expect(h.audit.entries.map((entry) => entry.error)).toEqual(failures.map(([, , code]) => code))
  })

  it('says reading is unavailable without a reader', async () => {
    h = toolHarness(sb)
    await put(path.join(sb.root, 'a.pdf'), Buffer.from(makePdf([{ text: ['x'] }])))
    expect(await run({ path: path.join(sb.root, 'a.pdf') })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/not available/) as unknown,
    })
  })

  describe('guards', () => {
    let reader: DocumentReader
    let calls: unknown[]

    beforeEach(() => {
      ;({ reader, calls } = fakeReader(() => pdfView()))
      h = toolHarness(sb, { documents: reader })
    })

    it('refuses files outside the grants, never reading them', async () => {
      await put(path.join(sb.outside, 'secret.pdf'), Buffer.from(makePdf([{ text: ['x'] }])))
      const r = await run({ path: path.join(sb.outside, 'secret.pdf') })
      expect(r).toMatchObject({
        isError: true,
        content: expect.stringMatching(/Access denied/) as unknown,
      })
      expect(calls).toHaveLength(0)
      expect(h.audit.entries[0]).toMatchObject({ outcome: 'error', error: 'access-denied' })
    })

    it('refuses secret files and protected paths', async () => {
      await put(path.join(sb.root, '.env'), 'SECRET=hunter2')
      await put(
        path.join(sb.userData, 'attachments', 'a.pdf'),
        Buffer.from(makePdf([{ text: ['x'] }])),
      )
      for (const file of [
        path.join(sb.root, '.env'),
        path.join(sb.userData, 'attachments', 'a.pdf'),
      ]) {
        const r = await run({ path: file })
        expect(r).toMatchObject({
          isError: true,
          content: expect.stringMatching(/Access denied/) as unknown,
        })
        expect(r.content).not.toContain('hunter2')
      }
      expect(calls).toHaveLength(0)
    })

    it('refuses to read through a link out of the grant', async (ctx) => {
      await put(path.join(sb.outside, 'secret.pdf'), Buffer.from(makePdf([{ text: ['x'] }])))
      if (
        !(await trySymlink(
          path.join(sb.outside, 'secret.pdf'),
          path.join(sb.root, 'x.pdf'),
          'file',
        ))
      )
        ctx.skip()
      const r = await run({ path: path.join(sb.root, 'x.pdf') })
      expect(r).toMatchObject({
        isError: true,
        content: expect.stringMatching(/outside the granted/) as unknown,
      })
      expect(calls).toHaveLength(0)
    })

    it('refuses a file with other hard links', async () => {
      await put(path.join(sb.outside, 'secret.pdf'), Buffer.from(makePdf([{ text: ['x'] }])))
      await fs.link(path.join(sb.outside, 'secret.pdf'), path.join(sb.root, 'innocent.pdf'))
      const r = await run({ path: path.join(sb.root, 'innocent.pdf') })
      expect(r).toMatchObject({
        isError: true,
        content: expect.stringMatching(/other hard links/) as unknown,
      })
      expect(calls).toHaveLength(0)
      expect(h.audit.entries[0]).toMatchObject({ outcome: 'error', error: 'hard-link' })
    })

    it('refuses folders, missing files and files over 100 MB', async () => {
      const big = path.join(sb.root, 'big.pdf')
      await put(big)
      await fs.truncate(big, 100 * 1024 * 1024 + 1)
      expect(await run({ path: sb.root })).toMatchObject({
        isError: true,
        content: expect.stringMatching(/Not a file/) as unknown,
      })
      expect(await run({ path: path.join(sb.root, 'nope.pdf') })).toMatchObject({
        isError: true,
        content: expect.stringMatching(/not found/) as unknown,
      })
      expect(await run({ path: big })).toMatchObject({
        isError: true,
        content: expect.stringMatching(/documents up to 100\.0 MB can be read/) as unknown,
      })
      expect(calls).toHaveLength(0)
      expect(h.audit.entries.map((entry) => entry.error)).toEqual([
        'not-a-file',
        'not-found',
        'too-large',
      ])
    })
  })
})

describe("read_file's binary refusal", () => {
  beforeEach(() => {
    h = toolHarness(sb)
  })

  it('points PDFs and images to read_document', async () => {
    // Real PDFs carry binary bytes early on (a comment line, compressed streams).
    await put(path.join(sb.root, 'a.pdf'), Buffer.from('%PDF-1.7\n%\u0000\u0001\n1 0 obj\n'))
    await put(
      path.join(sb.root, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
    )
    for (const [name, label] of [
      ['a.pdf', 'PDF'],
      ['img.png', 'PNG image'],
    ] as const) {
      const r = await h
        .tool('read_file')
        .execute({ path: path.join(sb.root, name) }, fakeContext().ctx)
      expect(r).toMatchObject({
        isError: true,
        content: `${path.join(sb.root, name)} is a ${label}, not text; use read_document to read it.`,
      })
    }
  })

  it('keeps the plain refusal for other binary files', async () => {
    await put(path.join(sb.root, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]))
    const r = await h
      .tool('read_file')
      .execute({ path: path.join(sb.root, 'blob.bin') }, fakeContext().ctx)
    expect(r).toMatchObject({
      isError: true,
      content: `${path.join(sb.root, 'blob.bin')} looks like a binary file; not reading it.`,
    })
  })
})
