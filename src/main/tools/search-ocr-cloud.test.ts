import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrImage, SystemOcr } from '../documents/system-ocr'
import type { DocumentReader, DocumentView } from '../documents/types'
import { fakeContext, makeSandbox, put, type Sandbox } from '../permissions/test-support'
import { DocumentTextCache } from './document-text-cache'
import { toolHarness, type ToolHarness } from './test-support'

/**
 * OCR needs a document's bytes, and reading a cloud-only placeholder downloads it. A cached
 * document is searched without reading it, so OCR reads what nothing else would have: these
 * tests make files look cloud-only at the points it must check, as Windows would report them
 * (the check itself, an allocation of zero, is tested in search-documents.test.ts).
 */
const cloud = vi.hoisted(() => ({
  /** Paths that report no allocation, and whether the handle (not the listing) sees it. */
  paths: new Set<string>(),
  handleOnly: false,
  /** Files whose bytes were read: what would have downloaded them. */
  reads: 0,
}))

vi.mock('./safe-fs', async (original) => {
  const actual = await original<typeof import('./safe-fs')>()
  return {
    ...actual,
    readBounded: (...args: Parameters<typeof actual.readBounded>) => {
      cloud.reads++
      return actual.readBounded(...args)
    },
  }
})

vi.mock('./search-documents', async (original) => {
  const actual = await original<typeof import('./search-documents')>()
  return {
    ...actual,
    // A walk's entry has `blocks` from its listing and an id; a handle's stats go through
    // readFileForReader, with no id: that tells the two checks apart here.
    isCloudOnly: (entry: { path: string; id?: unknown }) => {
      if (!cloud.paths.has(entry.path)) return false
      return cloud.handleOnly ? entry.id === undefined : true
    },
  }
})

const SENTENCE = 'Walk-in freezer door seals are shown on drawing A-501 with the heated threshold'

let sb: Sandbox
let h: ToolHarness
let cache: DocumentTextCache
let renders: number
let helperRuns: number
let textReads: number

const reader: DocumentReader = {
  extract(_bytes, options = {}) {
    const base = {
      meta: { kind: 'pdf' as const, mime: 'application/pdf', pageCount: 1 },
      images: [],
      warnings: [],
      position: {
        unit: 'page' as const,
        total: 1,
        shown: { from: 1, to: 1 },
        next: null,
      },
    }
    if (options.view === 'raster') {
      renders++
      const view: DocumentView = {
        ...base,
        sections: [],
        rasters: [{ page: 1, width: 2, height: 2, pixels: new Uint8Array([0, 255, 255, 0]) }],
      }
      return Promise.resolve(view)
    }
    textReads++
    return Promise.resolve({ ...base, sections: [{ page: 1, text: '' }] })
  },
}

const ocr: SystemOcr = {
  probe: () => Promise.resolve({ available: true, languages: ['en-US'], userLanguage: 'en-US' }),
  recognize: (image: OcrImage) => {
    helperRuns++
    return Promise.resolve({
      language: 'en-US',
      angle: null,
      width: image.width,
      height: image.height,
      lines: [{ text: SENTENCE, box: { x: 0, y: 0, width: 1, height: 1 } }],
      truncated: false,
      stats: { ms: 1, peakBytes: 1 },
    })
  },
  cancelAll: () => undefined,
}

const search = (input: Record<string, unknown>) =>
  h.tool('search_files').execute({ path: sb.root, ...input }, fakeContext().ctx)

beforeEach(async () => {
  sb = await makeSandbox()
  cloud.paths.clear()
  cloud.handleOnly = false
  cloud.reads = 0
  renders = 0
  helperRuns = 0
  textReads = 0
  cache = new DocumentTextCache({
    dir: path.join(sb.userData, 'document-text-cache'),
    grants: { list: () => [sb.root], token: () => 'grant' },
  })
  h = toolHarness(sb, { documents: reader, documentCache: cache, ocr })
  await put(path.join(sb.root, 'scan.pdf'), Buffer.from('%PDF-1.7\nscanned'))
})

afterEach(async () => {
  await sb.cleanup()
})

describe('search_files OCR and cloud-only files', () => {
  it('does not read a cloud-only file: the walk leaves it out, with no page rendered', async () => {
    cloud.paths.add(path.join(sb.root, 'scan.pdf'))
    const r = await search({ contentPattern: 'freezer' })
    expect(cloud.reads).toBe(0)
    expect(textReads + renders + helperRuns).toBe(0)
    expect(r.content).toContain('appears cloud-only')
  })

  it('does not download a cached document for its pending pages', async () => {
    // Its text was searched while it was on the PC; OCR never got to it, then it was freed.
    const noOcr = toolHarness(sb, { documents: reader, documentCache: cache })
    await noOcr
      .tool('search_files')
      .execute({ path: sb.root, contentPattern: 'freezer' }, fakeContext().ctx)
    expect(textReads).toBe(1)
    cloud.paths.add(path.join(sb.root, 'scan.pdf'))
    cloud.reads = 0
    const r = await search({ contentPattern: 'freezer' })
    expect(cloud.reads).toBe(0)
    expect(textReads).toBe(1)
    expect(renders + helperRuns).toBe(0)
    expect(r.content).toContain('appears cloud-only')
  })

  it('checks the handle again before reading: a file freed since the walk is left alone', async () => {
    const noOcr = toolHarness(sb, { documents: reader, documentCache: cache })
    await noOcr
      .tool('search_files')
      .execute({ path: sb.root, contentPattern: 'freezer' }, fakeContext().ctx)
    cloud.paths.add(path.join(sb.root, 'scan.pdf'))
    cloud.handleOnly = true
    cloud.reads = 0
    const r = await search({ contentPattern: 'freezer' })
    // Only the walk's look at the start of the file, when it was still on the PC: not the
    // read for OCR.
    expect(cloud.reads).toBe(1)
    expect(renders + helperRuns).toBe(0)
    expect(r.content).toContain('appears cloud-only')
    expect(r.content).not.toContain('OCR):')
  })
})
