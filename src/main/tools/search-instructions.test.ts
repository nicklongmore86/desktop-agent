import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT } from '../agent'
import { OcrError } from '../documents/system-ocr'
import type { DocumentReader } from '../documents/types'
import { fakeContext, makeSandbox, put, type Sandbox } from '../permissions/test-support'
import { DocumentTextCache } from './document-text-cache'
import { ocrProgress } from './search-files'
import { toolHarness, type ToolHarness } from './test-support'

/**
 * The agent's search guidance quotes search_files' parameters and result wording. These
 * tests run the real tool, so neither can change without the guidance changing with it.
 */

let sb: Sandbox
let h: ToolHarness

beforeEach(async () => {
  sb = await makeSandbox()
  h = toolHarness(sb)
})

afterEach(async () => {
  await sb.cleanup()
})

const search = async (input: Record<string, unknown>): Promise<string> =>
  (await h.tool('search_files').execute({ path: sb.root, ...input }, fakeContext().ctx)).content

describe('search guidance', () => {
  it.each([
    ['terminology', 'spelling variants, synonyms and the abbreviations used in that field'],
    ['an example', '"walk-in freezer", "walk-in cooler", "WIF", "WIC"'],
    ['no wasted terms', 'already handles case, spaces, hyphens and line breaks'],
    ['broad terms', 'start with output: "files" to see where it occurs, then narrow'],
    ['continuation', 'continue with that cursor before concluding'],
    ['absence', 'never state or imply that something is not mentioned unless'],
    ['coverage', 'skipped files, scanned pages OCR did not read or found little text on'],
    ['what OCR reads', 'reads scanned PDF pages with OCR when this PC has it'],
    ['OCR errors', 'OCR text can contain errors'],
    ['what OCR leaves', 'scanned pages not reached or not OCR-able are reported'],
    ['no proof from OCR', 'a scanned file with no match is not proof the words are absent'],
    ['picking pages', 'Read the likely scanned pages with read_document, picking a few'],
    ['next step', 'offer that as the next step'],
    ['hit limits', 'A limit on the matches shown says nothing about which files were checked'],
    [
      'cursor needs the same terms',
      'A cursor only works with exactly the same arguments and terms',
    ],
    ['changing terms', 'to change the terms, start a new search (OCR already done is kept)'],
    ['long OCR', 'keep continuing with the cursor while each call'],
    [
      'stopping long OCR',
      'clearly will not fit in this reply, stop and give the user what was found',
    ],
    ['unread list', 'the scanned PDFs still waiting for OCR as the result lists them'],
    ['options', 'continue in another message (pages already read are kept), narrow the search'],
    ['reading files', 'or read specific files with read_document'],
    [
      'no absence with OCR left',
      'Never say something is absent while scanned pages are still unread',
    ],
  ])('covers %s', (_topic, phrase) => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain(phrase)
  })

  it('keeps the guidance on one search at a time and on continuing with a cursor', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Run one search_files call at a time')
    // Without its cursor a call starts over: nothing may say the same arguments are enough.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain('with the same arguments to continue')
  })

  it('names only tools and search_files parameters that exist', () => {
    expect(h.tools).toHaveProperty('search_files')
    expect(h.tools).toHaveProperty('read_document')
    const { properties } = h.tool('search_files').inputSchema
    for (const parameter of ['anyOf', 'output', 'cursor']) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(parameter)
      expect(properties).toHaveProperty(parameter)
    }
    expect(properties).toHaveProperty('output.enum', expect.arrayContaining(['files']))
  })

  it('quotes the wording of a complete search, a stopped one and its continuation', async () => {
    for (let i = 0; i < 12; i++) {
      await put(path.join(sb.root, `f${String(i).padStart(2, '0')}.txt`), 'freezer\n')
    }
    expect(await search({ contentPattern: 'freezer' })).toContain('Every file was checked')

    h = toolHarness(sb, { limits: { maxSearchEntries: 5 } })
    const first = await search({ contentPattern: 'freezer' })
    expect(first).toContain('Not every file was checked')
    const cursor = /cursor: "(sf1\.[\w-]+)"\.$/m.exec(first)?.[1]
    expect(cursor).toBeDefined()

    h = toolHarness(sb)
    const rest = await search({ contentPattern: 'freezer', cursor })
    expect(rest).toContain('Every file after the cursor was checked')

    for (const wording of [
      '"Not every file"',
      '"Every file was checked"',
      '"Every file after the cursor was checked"',
    ])
      expect(DEFAULT_SYSTEM_PROMPT).toContain(wording)
    expect(h.tool('search_files').description).toContain('"Every file was checked"')
    expect(h.tool('search_files').description).toContain(
      'Every match in the files checked is counted',
    )
  })

  it('no longer says scanned PDFs are not searched, here or in the tool', () => {
    const description = h.tool('search_files').description
    for (const stale of [
      'scanned PDFs with no text layer',
      'not images or scanned PDFs',
      'read photos, scanned PDFs',
      'Read the likely scanned files',
    ]) {
      expect(DEFAULT_SYSTEM_PROMPT).not.toContain(stale)
      expect(description).not.toContain(stale)
    }
  })

  it('tells the truth about OCR, in the tool’s description and what the tool reports', async () => {
    const description = h.tool('search_files').description
    expect(description).toContain('Scanned PDF pages are read by OCR when this PC has it')
    expect(description).toContain('OCR text can contain errors')
    expect(description).toContain('Pages not reached or not OCR-able are reported')
    expect(description).toContain('"(page 3, OCR)"')
    expect(description).toContain('the scanned pages it reports as not fully read')

    // A scanned page, read through the real tool with a fake reader and helper.
    await put(path.join(sb.root, 'read.pdf'), Buffer.from('%PDF-1.7\nread'))
    await put(path.join(sb.root, 'failed.pdf'), Buffer.from('%PDF-1.7\nfailed'))
    let current = ''
    const reader: DocumentReader = {
      extract: (bytes, options = {}) => {
        current = options.name ?? ''
        return Promise.resolve({
          meta: { kind: 'pdf', mime: 'application/pdf', pageCount: 1 },
          images: [],
          warnings: [],
          sections: options.view === 'raster' ? [] : [{ page: 1, text: '' }],
          ...(options.view === 'raster'
            ? {
                rasters: [
                  { page: 1, width: 2, height: 2, pixels: new Uint8Array([0, 255, 255, 0]) },
                ],
              }
            : {}),
          position: { unit: 'page', total: 1, shown: { from: 1, to: 1 }, next: null },
        })
      },
    }
    const text = 'Walk-in freezer door seals are shown on drawing A-501 with the heated threshold'
    h = toolHarness(sb, {
      documents: reader,
      documentCache: new DocumentTextCache({
        dir: path.join(sb.userData, 'cache'),
        grants: { list: () => [sb.root], token: () => 'grant' },
      }),
      ocr: {
        probe: () =>
          Promise.resolve({ available: true, languages: ['en-US'], userLanguage: 'en-US' }),
        recognize: (image) =>
          current === 'failed.pdf'
            ? Promise.reject(new OcrError('memory', 'too much'))
            : Promise.resolve({
                language: 'en-US',
                angle: null,
                width: image.width,
                height: image.height,
                lines: [{ text, box: { x: 0, y: 0, width: 1, height: 1 } }],
                truncated: false,
                stats: { ms: 1, peakBytes: 1 },
              }),
        cancelAll: () => undefined,
      },
    })
    const result = await search({ contentPattern: 'walk-in freezer', context: 0 })
    expect(result).toContain('read.pdf (page 1, OCR): Walk-in freezer')
    expect(result).toContain('Every file was checked')
    // What the guidance says to leave out is said in the same words by the tool.
    expect(result).toContain('pages OCR could not fully read')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('scanned pages OCR could not fully read')
    expect(result).toContain('OCR text, marked "(page N, OCR)", can contain errors')
    expect(result).toContain('not proof the words are absent')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('not proof the words are absent')
    expect(result).toContain('ask the user before doing many')
  })

  it('quotes the words of the OCR progress line and the list of PDFs waiting for OCR', () => {
    expect(ocrProgress(200, 180_000, 2400, false)).toMatch(/^OCR progress: .* estimate/i)
    expect(DEFAULT_SYSTEM_PROMPT).toContain('"OCR progress" line')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('its estimate')
    // The list's title (search-ocr.test.ts runs it) and its order, as the guidance names them.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('waiting for OCR')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('names with a searched word first')
  })

  it('tells the truth about flexible matching: spaces, hyphens and line breaks', async () => {
    await put(path.join(sb.root, 'rfi.txt'), 'See the WALK-IN\nfreezer door.\n')
    const result = await search({ contentPattern: 'walk in freezer' })
    expect(result).toContain('Every file was checked: 1 match in 1 file')
  })
})
