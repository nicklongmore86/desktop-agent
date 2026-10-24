import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readExif } from '../src/main/documents/exif'
import { makeExif, makePdf, withExif } from '../src/main/documents/fixtures.test-util'
import { imageDimensions } from '../src/main/documents/limits'

/**
 * read_document in real Electron: the agent's tools (out/main/tools.js) over the real
 * DocumentWorkerHost, whose sandboxed worker parses with PDFium WASM and Chromium's
 * codecs. Files are written to a granted temp folder and read through the tool, with the
 * same guard as the app: a PDF (text, a drawn page as an image, the next-page hint, a
 * zoomed region), a rotated photo (upright, metadata stripped, GPS only when asked and
 * audited), guard refusals, and worker failures as clean tool errors.
 */

/** A ToolResult as the harness returns it: each image's bytes as base64, and decoded. */
interface Image {
  mime: string
  data: string
  width: number
  height: number
  label?: string
  decodedSize: { width: number; height: number }
}
interface Result {
  content: string
  isError?: boolean
  images?: Image[]
}
/** The audit entry fields these tests look at. */
interface AuditEntry {
  tool: string
  args: Record<string, unknown>
  paths: string[]
  approval: string
  outcome: 'ok' | 'error'
  error?: string
}

interface Harness {
  grant: (root: string, blocked?: string[]) => void
  run: (tool: string, input: unknown) => Promise<Result>
  audit: () => AuditEntry[]
  makeJpeg: (width: number, height: number) => string
}

async function launch(hostOptions: Record<string, unknown> = {}): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/read-document-main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_DOCUMENT_HOST: JSON.stringify(hostOptions) },
  })
  await app.evaluate(async ({ app: electronApp }) => {
    await electronApp.whenReady()
    while (!(globalThis as { reader?: unknown }).reader) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
  return app
}

const reader = (app: ElectronApplication) => ({
  grant: (root: string, blocked: string[] = []) =>
    app.evaluate(
      (_electron, [r, b]) => {
        ;(globalThis as unknown as { reader: Harness }).reader.grant(r, b)
      },
      [root, blocked] as const,
    ),
  run: (input: Record<string, unknown>, tool = 'read_document'): Promise<Result> =>
    app.evaluate(
      (_electron, [name, value]) =>
        (globalThis as unknown as { reader: Harness }).reader.run(name, value),
      [tool, input] as const,
    ),
  audit: () => app.evaluate(() => (globalThis as unknown as { reader: Harness }).reader.audit()),
  makeJpeg: async (width: number, height: number): Promise<Uint8Array> =>
    Buffer.from(
      await app.evaluate(
        (_electron, [w, h]) => (globalThis as unknown as { reader: Harness }).reader.makeJpeg(w, h),
        [width, height] as const,
      ),
      'base64',
    ),
})

/** A temp folder with a granted `root`, an ungranted `outside` and a protected `userData`. */
function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'read-document-')))
  const dirs = {
    root: join(base, 'root'),
    outside: join(base, 'outside'),
    userData: join(base, 'userData'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir)
  return {
    ...dirs,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true })
    },
  }
}

const bytesOf = (image: Image | undefined): Uint8Array => Buffer.from(image?.data ?? '', 'base64')

test.describe('read_document over the sandboxed worker', () => {
  let app: ElectronApplication
  let dirs: ReturnType<typeof sandbox>

  test.beforeAll(async () => {
    app = await launch()
    dirs = sandbox()
    await reader(app).grant(dirs.root, [dirs.userData])
  })

  test.afterAll(async () => {
    await app.close()
    dirs.cleanup()
  })

  test('PDF: text per page, a drawn page as an image, the next-page hint and a zoomed region', async () => {
    const file = join(dirs.root, 'survey.pdf')
    writeFileSync(
      file,
      makePdf([
        { text: ['Site survey', 'Ground floor plan follows on the next page.'] },
        { drawing: true },
        { text: ['Appendix A: drainage calculations for the north field.'] },
      ]),
    )
    const first = await reader(app).run({ path: file, pages: '1-2' })
    expect(first.isError).toBeUndefined()
    const lines = first.content.split('\n')
    expect(lines[0]).toMatch(
      /^\[.*survey\.pdf \| PDF \| [\d.]+ KB \| 3 pages \| pages 1-2 shown\]$/,
    )
    expect(lines.slice(1)).toEqual([
      '--- Page 1 ---',
      'Site survey',
      'Ground floor plan follows on the next page.',
      '--- Page 2 (little or no text; attached as image 1) ---',
      '[More: pages 3-3 not shown. Call read_document with start: 3 to continue.]',
    ])
    expect(first.images).toHaveLength(1)
    const [page] = first.images ?? []
    expect(page).toMatchObject({ mime: 'image/png', width: 1212, height: 1568, label: 'page 2' })
    expect(imageDimensions(bytesOf(page), 'png')).toEqual({ width: 1212, height: 1568 })
    expect(page?.decodedSize).toEqual({ width: 1212, height: 1568 })

    const rest = await reader(app).run({ path: file, start: 3 })
    expect(rest.content).toContain(
      '--- Page 3 ---\nAppendix A: drainage calculations for the north field.\n[End of document.]',
    )
    expect(rest.images).toBeUndefined()

    const region = { page: 2, x: 0.15, y: 0.2, width: 0.25, height: 0.25 }
    const zoomed = await reader(app).run({ path: file, region })
    expect(zoomed.isError).toBeUndefined()
    expect(zoomed.images).toHaveLength(1)
    expect(zoomed.images?.[0]).toMatchObject({ label: 'page 2, zoomed region', width: 1212 })
    expect(zoomed.content).toContain('[No text in this region.]')

    expect((await reader(app).audit()).slice(-3)).toEqual([
      expect.objectContaining({
        tool: 'read_document',
        args: { path: file, from: 1, to: 2, kind: 'pdf', images: 1 },
        paths: [file],
        approval: 'auto',
        outcome: 'ok',
      }),
      expect.objectContaining({ args: { path: file, start: 3, kind: 'pdf', images: 0 } }),
      expect.objectContaining({ args: { path: file, region, kind: 'pdf', images: 1 } }),
    ])
  })

  test('photo: upright, scaled, metadata stripped, facts as text, GPS only when asked', async () => {
    // Stored 400x200, left red / right blue; orientation 6 makes it 200x400 upright.
    const photo = withExif(
      await reader(app).makeJpeg(400, 200),
      makeExif({
        orientation: 6,
        make: 'Canon',
        model: 'EOS R6',
        dateTimeOriginal: '2026:07:14 09:30:12',
        gps: { lat: 51.5007, latRef: 'N', lon: 0.1246, lonRef: 'W' },
      }),
    )
    const file = join(dirs.root, 'IMG_0001.jpg')
    writeFileSync(file, photo)

    const plain = await reader(app).run({ path: file })
    expect(plain.isError).toBeUndefined()
    expect(plain.content).toContain('JPEG image')
    expect(plain.content).toContain('200 x 400 px')
    expect(plain.content).toContain('Captured: 2026:07:14 09:30:12')
    expect(plain.content).toContain('Camera: Canon EOS R6')
    expect(plain.content).toContain('Location: recorded (not included; ask with include_location)')
    expect(plain.content).not.toContain('51.5')
    const [image] = plain.images ?? []
    expect(image).toMatchObject({ mime: 'image/jpeg', width: 200, height: 400, label: 'image' })
    const output = bytesOf(image)
    expect(readExif(output, 'jpeg')).toBeNull()
    expect(Buffer.from(output).includes(Buffer.from('Exif\0\0'))).toBe(false)

    const located = await reader(app).run({ path: file, include_location: true })
    expect(located.content).toMatch(/Location: 51\.50\d*, -0\.12\d*/)
    const audit = (await reader(app).audit()).slice(-2)
    expect(audit.map((entry) => entry.args)).toEqual([
      { path: file, kind: 'jpeg', images: 1 },
      { path: file, includeLocation: true, kind: 'jpeg', images: 1, locationRead: true },
    ])
  })

  test('refuses files outside the grant, secrets and protected paths, without reading them', async () => {
    const pdf = makePdf([{ text: ['private'] }])
    writeFileSync(join(dirs.outside, 'secret.pdf'), pdf)
    writeFileSync(join(dirs.root, '.env'), 'SECRET=hunter2')
    writeFileSync(join(dirs.userData, 'held.pdf'), pdf)
    for (const file of [
      join(dirs.outside, 'secret.pdf'),
      join(dirs.root, '.env'),
      join(dirs.userData, 'held.pdf'),
    ]) {
      const result = await reader(app).run({ path: file })
      expect(result.isError, file).toBe(true)
      expect(result.content).toMatch(/^Access denied/)
      expect(result.content).not.toMatch(/private|hunter2/)
    }
    expect(
      (await reader(app).audit()).slice(-3).map((entry) => [entry.outcome, entry.error]),
    ).toEqual([
      ['error', 'access-denied'],
      ['error', 'access-denied'],
      ['error', 'access-denied'],
    ])
  })

  test('an unreadable PDF is a clean error and the next call works', async () => {
    const broken = join(dirs.root, 'broken.pdf')
    writeFileSync(broken, makePdf([{ text: ['x'] }], { encrypted: true }))
    const refused = await reader(app).run({ path: broken })
    expect(refused).toMatchObject({ isError: true })
    expect(refused.content).toMatch(/password-protected/)
    const good = join(dirs.root, 'good.pdf')
    writeFileSync(good, makePdf([{ text: ['Still here'] }]))
    expect((await reader(app).run({ path: good })).content).toContain('Still here')
  })

  test('read_file points the PDF to read_document', async () => {
    const file = join(dirs.root, 'binary.pdf')
    writeFileSync(
      file,
      Buffer.concat([Buffer.from('%PDF-1.7\n%\0\x01\n'), makePdf([{ text: ['x'] }])]),
    )
    expect(await reader(app).run({ path: file }, 'read_file')).toMatchObject({
      isError: true,
      content: `${file} is a PDF, not text; use read_document to read it.`,
    })
  })
})

test('a worker that times out or misbehaves is a clean tool error, never a crash', async () => {
  for (const [options, name, code] of [
    [{ timeoutMs: 5 }, 'slow.pdf', 'timeout'],
    [{ hostile: true, timeoutMs: 15_000 }, 'garbage', 'worker-failed'],
  ] as const) {
    const app = await launch(options)
    const dirs = sandbox()
    try {
      await reader(app).grant(dirs.root)
      const file = join(dirs.root, name)
      writeFileSync(file, makePdf([{ text: ['x'] }]))
      const result = await reader(app).run({ path: file })
      expect(result.isError, name).toBe(true)
      expect(result.content).toMatch(/^Could not read /)
      expect((await reader(app).audit()).at(-1)).toMatchObject({ outcome: 'error', error: code })
      // Main is still answering.
      expect(await app.evaluate(() => 1 + 1)).toBe(2)
    } finally {
      await app.close()
      dirs.cleanup()
    }
  }
})
