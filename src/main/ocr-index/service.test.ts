import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrIndexJob } from '../../shared/ipc-ocr-index'
import { rootId } from '../files/location'
import { PathGuard } from '../permissions/guard'
import {
  fakeContext,
  makeSandbox,
  MemoryAudit,
  put,
  type Sandbox,
} from '../permissions/test-support'
import { DocumentTextCache, type CachedText } from '../tools/document-text-cache'
import { OcrPriority } from '../tools/ocr-priority'
import { toolHarness } from '../tools/test-support'
import { createOcrIndexService, OCR_INDEX_REFUSAL, type OcrIndexService } from './service'
import {
  fakeOcr,
  gate,
  scans,
  scriptedPdf,
  scriptedReader,
  SENTENCE,
  until,
  type FakeOcr,
  type ScriptedReader,
} from './test-support'

/**
 * Background indexing of scanned pages with a scripted reader and a fake OCR: the order of
 * work, its controls and what it keeps. The real helper on a real PDF is in
 * service-real.test.ts (Windows).
 */

/** Paths that look like OneDrive placeholders whose content is not on this PC. */
const cloud = vi.hoisted(() => ({ paths: new Set<string>(), reads: [] as string[] }))

vi.mock('../tools/search-documents', async (original) => {
  const actual = await original<typeof import('../tools/search-documents')>()
  return {
    ...actual,
    isCloudOnly: (entry: { path: string }) => cloud.paths.has(entry.path),
  }
})

vi.mock('../tools/safe-fs', async (original) => {
  const actual = await original<typeof import('../tools/safe-fs')>()
  return {
    ...actual,
    openVerified: async (...args: Parameters<typeof actual.openVerified>) => {
      cloud.reads.push(args[1])
      return actual.openVerified(...args)
    },
  }
})

vi.setConfig({ testTimeout: 30_000 })

let sb: Sandbox
let reader: ScriptedReader
let ocr: FakeOcr
let cache: DocumentTextCache
let priority: OcrPriority
let audit: MemoryAudit
let guard: PathGuard
/** The grant's token: cleared by a test to remove the grant. */
let token: string | null
let roots: string[]
let pushed: OcrIndexJob[][]
let services: OcrIndexService[]

const stateFile = (): string => path.join(sb.userData, 'ocr-index.json')

function service(): OcrIndexService {
  const made = createOcrIndexService({
    guard,
    reader,
    ocr,
    cache,
    priority,
    audit,
    stateFile: stateFile(),
    emit: (jobs) => pushed.push(jobs),
    limits: { pollMs: 5, emitEveryMs: 5 },
  })
  services.push(made)
  return made
}

beforeEach(async () => {
  sb = await makeSandbox()
  token = 'grant-1'
  roots = [sb.root]
  reader = scriptedReader()
  ocr = fakeOcr(reader)
  priority = new OcrPriority()
  audit = new MemoryAudit()
  guard = new PathGuard({ roots: () => roots, protectedPaths: [sb.userData] })
  cache = new DocumentTextCache({
    dir: path.join(sb.userData, 'document-text-cache'),
    grants: { list: () => roots, token: (root) => (root === sb.root ? token : null) },
  })
  pushed = []
  services = []
  cloud.paths.clear()
  cloud.reads = []
})

afterEach(async () => {
  for (const made of services) await made.dispose()
  await sb.cleanup()
})

const whole = { rootId: '', rel: '' }
const folder = (rel = '') => ({ ...whole, rootId: rootId(sb.root), rel })
const only = (index: OcrIndexService): OcrIndexJob => {
  const [job] = index.list()
  if (!job) throw new Error('no job')
  return job
}
const stateOf = (index: OcrIndexService) => index.list()[0]?.state
const textOf = async (name: string): Promise<CachedText | null> => {
  const stats = await fs.stat(path.join(sb.root, name), { bigint: true })
  return cache.get({
    root: sb.root,
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  })
}
const readsOf = (name: string): string[] =>
  ocr.reads.filter((read) => read.startsWith(`${name}#`)).sort()
const pagesOf = (name: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${name}#${String(i + 1)}`).sort()
const events = () => audit.entries.filter((entry) => entry.tool === 'ocr_index')

describe('background indexing of scanned pages', () => {
  it('reads every scanned page of a folder once, keeps it, and says how far it got', async () => {
    await put(path.join(sb.root, 'rfi/a.pdf'), scans(3, 'Alpha'))
    await put(path.join(sb.root, 'rfi/b.pdf'), scans(2, 'Bravo'))
    await put(path.join(sb.root, 'rfi/text.pdf'), scriptedPdf({ text: 'A page of plain text.' }))
    await put(path.join(sb.root, 'rfi/notes.txt'), 'not a PDF')
    const index = service()
    expect(await index.start(folder('rfi'))).toEqual({ ok: true })
    await until(() => stateOf(index) === 'finished')
    const job = only(index)
    expect(job).toMatchObject({
      rel: 'rfi',
      name: 'rfi',
      path: path.join(sb.root, 'rfi'),
      filesChecked: 3,
      filesTotal: 3,
      pagesDone: 5,
      pagesTotal: 5,
      pagesFailed: 0,
      minutesLeft: null,
      message: 'Every scanned page that could be read has been read.',
    })
    // Exactly once each, in the cache as a search keeps them.
    expect(readsOf('a.pdf')).toEqual(pagesOf('a.pdf', 3))
    expect(readsOf('b.pdf')).toEqual(pagesOf('b.pdf', 2))
    const a = await textOf('rfi/a.pdf')
    expect(a?.ocr.map((page) => [page.state, page.text.split('\n')[0]])).toEqual([
      ['done', 'Alpha page 1'],
      ['done', 'Alpha page 2'],
      ['done', 'Alpha page 3'],
    ])
    // Every reader job was a background one: read_document goes ahead of it.
    expect(reader.calls.every((call) => call.background)).toBe(true)
    // Progress was pushed on the way, pages read climbing to the total.
    const done = pushed.map((jobs) => jobs[0]?.pagesDone ?? 0)
    expect(done.at(-1)).toBe(5)
    expect(pushed.some((jobs) => jobs[0]?.state === 'checking')).toBe(true)
    expect(pushed.some((jobs) => jobs[0]?.state === 'reading')).toBe(true)
    // Audit: start and complete, counts only.
    const [start, complete] = events()
    expect(start?.args).toMatchObject({ event: 'start' })
    expect(complete?.args).toMatchObject({
      event: 'complete',
      filesChecked: 3,
      pagesDone: 5,
      pagesTotal: 5,
      pagesReadThisRun: 5,
    })
    expect(complete?.paths).toEqual([path.join(sb.root, 'rfi')])
    expect(complete?.origin).toBe('user')
    expect(JSON.stringify(events())).not.toMatch(/Alpha|Bravo|a\.pdf|freezer/)
    // A finished job is no longer kept for the next start.
    expect(JSON.parse(await fs.readFile(stateFile(), 'utf8'))).toEqual({ version: 1, jobs: [] })
  })

  it('makes way for a search: nothing new starts, the pages being read are kept once', async () => {
    await put(path.join(sb.root, 'big.pdf'), scans(6, 'Big'))
    // Every page waits until the test lets it go: two are being read (two helpers) when the
    // search comes.
    const held = gate()
    let reading = 0
    ocr.before = async () => {
      reading++
      await held.wait
    }
    const index = service()
    await index.start(folder())
    await until(() => reading >= 2)
    // A search claims the reader and helpers while page 1 is being read.
    const claim = priority.claim()
    const quiet = claim.quiet(10_000, new AbortController().signal)
    let quietened = false
    void quiet.then(() => (quietened = true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(quietened).toBe(false)
    const startedBefore = reading
    held.open()
    await quiet
    // The pages being read were finished and kept before the search went on.
    expect((await textOf('big.pdf'))?.ocr.map((page) => page.state)).toEqual([
      'done',
      'done',
      'pending',
      'pending',
      'pending',
      'pending',
    ])
    await until(() => stateOf(index) === 'waiting')
    const rasters = reader.calls.filter((call) => call.view === 'raster').length
    await new Promise((resolve) => setTimeout(resolve, 60))
    // While the search holds it: no new page, no new reader job.
    expect(reader.calls.filter((call) => call.view === 'raster')).toHaveLength(rasters)
    expect(reading).toBe(startedBefore)
    claim.release()
    await until(() => stateOf(index) === 'finished')
    expect(readsOf('big.pdf')).toEqual(pagesOf('big.pdf', 6))
  })

  it('waits to start while a search holds the reader', async () => {
    await put(path.join(sb.root, 'one.pdf'), scans(1, 'One'))
    const claim = priority.claim()
    const index = service()
    await index.start(folder())
    await until(() => stateOf(index) === 'waiting')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(reader.calls).toHaveLength(0)
    expect(only(index).message).toBe('Making way for a search, which comes first.')
    claim.release()
    await until(() => stateOf(index) === 'finished')
  })

  it('pauses with what it read kept, reads nothing while paused, and resumes', async () => {
    await put(path.join(sb.root, 'p.pdf'), scans(5, 'Pause'))
    const held = gate()
    ocr.before = async (_name, page) => {
      if (page >= 2) await held.wait
    }
    const index = service()
    await index.start(folder())
    await until(() => ocr.reads.length >= 1)
    const id = only(index).id
    expect(await index.pause(id)).toEqual({ ok: true })
    held.open()
    await until(() => stateOf(index) === 'paused')
    const readSoFar = ocr.reads.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(ocr.reads).toHaveLength(readSoFar)
    expect(only(index).message).toBe('Paused. Pages read so far are kept.')
    // Kept for the next start, as paused.
    expect(JSON.parse(await fs.readFile(stateFile(), 'utf8'))).toMatchObject({
      jobs: [{ id, rel: '', paused: true }],
    })
    expect(await index.resume(id)).toEqual({ ok: true })
    await until(() => stateOf(index) === 'finished')
    expect(readsOf('p.pdf')).toEqual(pagesOf('p.pdf', 5))
    expect(events().map((entry) => (entry.args as { event: string }).event)).toEqual([
      'start',
      'stop',
      'start',
      'complete',
    ])
    expect(events()[1]?.args).toMatchObject({ reason: 'paused' })
  })

  it('cancels: the helpers stop, nothing more is read, and the job is gone', async () => {
    await put(path.join(sb.root, 'c.pdf'), scans(6, 'Cancel'))
    const held = gate()
    ocr.before = async (_name, page) => {
      if (page >= 2) await held.wait
    }
    const index = service()
    await index.start(folder())
    await until(() => ocr.reads.length >= 1)
    const id = only(index).id
    expect(await index.cancel(id)).toEqual({ ok: true })
    held.open()
    expect(index.list()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(ocr.reads.length).toBeLessThan(6)
    expect(pushed.at(-1)).toEqual([])
    expect(JSON.parse(await fs.readFile(stateFile(), 'utf8'))).toEqual({ version: 1, jobs: [] })
    expect(events().at(-1)?.args).toMatchObject({ event: 'stop', reason: 'cancelled' })
    // Pages read before the cancel stay read; nothing else was deleted.
    expect((await textOf('c.pdf'))?.ocr[0]?.state).toBe('done')
    expect(await index.cancel(id)).toEqual({ ok: false, reason: OCR_INDEX_REFUSAL.unknown })
  })

  it('pauses on battery power and goes on once the PC is plugged in', async () => {
    await put(path.join(sb.root, 'b.pdf'), scans(2, 'Battery'))
    ocr.battery = true
    const index = service()
    await index.start(folder())
    await until(() => stateOf(index) === 'battery')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(reader.calls).toHaveLength(0)
    expect(only(index).message).toBe(
      'Paused while this PC runs on battery power. It goes on when the PC is plugged in.',
    )
    ocr.battery = false
    await until(() => stateOf(index) === 'finished')
    expect(readsOf('b.pdf')).toEqual(pagesOf('b.pdf', 2))
  })

  it('stops reading pages when the PC goes on battery mid-way, then finishes the rest', async () => {
    await put(path.join(sb.root, 'm.pdf'), scans(4, 'Mid'))
    ocr.before = (_name, page) => {
      if (page === 2) ocr.battery = true
    }
    const index = service()
    await index.start(folder())
    await until(() => stateOf(index) === 'battery')
    const read = ocr.reads.length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(ocr.reads).toHaveLength(read)
    delete ocr.before
    ocr.battery = false
    await until(() => stateOf(index) === 'finished')
    expect(readsOf('m.pdf')).toEqual(pagesOf('m.pdf', 4))
  })

  it('goes on after a restart from what the cache kept, reading no page twice', async () => {
    await put(path.join(sb.root, 'r.pdf'), scans(6, 'Restart'))
    const held = gate()
    ocr.before = async (_name, page) => {
      if (page >= 4) await held.wait
    }
    const first = service()
    await first.start(folder())
    await until(() => ocr.reads.length >= 3)
    // Quit: the job stops where it is; pages read so far were kept on the way.
    await first.dispose()
    held.open()
    expect(JSON.parse(await fs.readFile(stateFile(), 'utf8'))).toMatchObject({
      jobs: [{ rel: '', paused: false }],
    })
    delete ocr.before
    // The next start: a new service over the same cache and state file.
    const second = service()
    await second.load()
    await until(() => stateOf(second) === 'finished')
    // Every page read once: page 4's run at quit was stopped, not read.
    expect(readsOf('r.pdf')).toEqual(pagesOf('r.pdf', 6))
    expect(events().find((e) => (e.args as { afterRestart?: boolean }).afterRestart)).toBeDefined()
  })

  it('keeps a paused job paused after a restart', async () => {
    await put(path.join(sb.root, 'k.pdf'), scans(1, 'Kept'))
    ocr.battery = true
    const first = service()
    await first.start(folder())
    await first.pause(only(first).id)
    await until(() => stateOf(first) === 'paused')
    await first.dispose()
    ocr.battery = false
    const second = service()
    await second.load()
    expect(stateOf(second)).toBe('paused')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(ocr.reads).toEqual([])
  })

  it('drops saved jobs for folders no longer granted, and anything malformed', async () => {
    await fs.writeFile(
      stateFile(),
      JSON.stringify({
        version: 1,
        jobs: [{ id: '0123456789abcdef', root: sb.outside, rel: '', paused: false }],
      }),
    )
    const index = service()
    await index.load()
    expect(index.list()).toEqual([])
    await fs.writeFile(stateFile(), '{"version":1,"jobs":[{"root":"C:\\\\"}]}')
    await service().load()
    await fs.writeFile(stateFile(), 'not json')
    await service().load()
    expect(ocr.reads).toEqual([])
  })

  it('ends when the folder’s grant is removed, keeping nothing more', async () => {
    await put(path.join(sb.root, 'g.pdf'), scans(6, 'Grant'))
    const held = gate()
    ocr.before = async (_name, page) => {
      if (page >= 2) await held.wait
    }
    const index = service()
    await index.start(folder())
    await until(() => ocr.reads.length >= 1)
    // The grant store removes the grant, then its listeners run (the cache deletes its folder).
    roots = []
    token = null
    await cache.forgetGrant(sb.root)
    await index.forgetGrant(sb.root)
    held.open()
    expect(index.list()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await fs.readdir(path.join(sb.userData, 'document-text-cache'))).toEqual([])
    expect(events().at(-1)?.args).toMatchObject({ event: 'stop', reason: 'grant-removed' })
  })

  it('never downloads an online-only file: it is counted, with a note', async () => {
    await put(path.join(sb.root, 'local.pdf'), scans(1, 'Local'))
    await put(path.join(sb.root, 'online.pdf'), scans(3, 'Online'))
    cloud.paths.add(path.join(sb.root, 'online.pdf'))
    const index = service()
    await index.start(folder())
    await until(() => stateOf(index) === 'finished')
    expect(only(index)).toMatchObject({ cloudOnly: 1, filesTotal: 1, pagesTotal: 1 })
    expect(cloud.reads).not.toContain(path.join(sb.root, 'online.pdf'))
    expect(readsOf('online.pdf')).toEqual([])
  })

  it('counts a page OCR fails on, and tries it again on the next run', async () => {
    await put(path.join(sb.root, 'f.pdf'), scriptedPdf({ ocr: [SENTENCE] }, { fails: true }))
    const index = service()
    await index.start(folder())
    await until(() => stateOf(index) === 'finished')
    expect(only(index)).toMatchObject({ pagesDone: 1, pagesTotal: 2, pagesFailed: 1 })
    expect((await textOf('f.pdf'))?.ocr[1]?.state).toBe('pending')
  })

  it('stops with the reason when OCR cannot run, and refuses to start then', async () => {
    await put(path.join(sb.root, 'x.pdf'), scans(1, 'X'))
    ocr.available = false
    const index = service()
    expect(await index.start(folder())).toEqual({
      ok: false,
      reason: 'Reading scanned pages needs Windows.',
    })
    expect(index.list()).toEqual([])
  })

  it('refuses a folder already being indexed, inside one, or around one', async () => {
    await fs.mkdir(path.join(sb.root, 'a/b'), { recursive: true })
    ocr.battery = true
    const index = service()
    expect(await index.start(folder('a'))).toEqual({ ok: true })
    expect(await index.start(folder('a'))).toEqual({ ok: false, reason: OCR_INDEX_REFUSAL.same })
    expect(await index.start(folder('a/b'))).toEqual({
      ok: false,
      reason: OCR_INDEX_REFUSAL.inside,
    })
    expect(await index.start(folder())).toEqual({ ok: false, reason: OCR_INDEX_REFUSAL.holds })
    expect(await index.start(folder('a/missing'))).toMatchObject({ ok: false })
    await put(path.join(sb.root, 'file.pdf'), scans(1, 'F'))
    expect(await index.start(folder('file.pdf'))).toEqual({
      ok: false,
      reason: OCR_INDEX_REFUSAL.notFolder,
    })
    expect(await index.start({ rootId: 'r0000000000000000', rel: '' })).toMatchObject({
      ok: false,
    })
  })

  it('runs one folder at a time, the next queued', async () => {
    await put(path.join(sb.root, 'one/a.pdf'), scans(2, 'A'))
    await put(path.join(sb.root, 'two/b.pdf'), scans(2, 'B'))
    const held = gate()
    ocr.before = async () => held.wait
    const index = service()
    await index.start(folder('one'))
    await index.start(folder('two'))
    await until(() => index.list()[0]?.state === 'reading')
    expect(index.list()[1]?.state).toBe('queued')
    held.open()
    await until(() => index.list().every((job) => job.state === 'finished'))
    expect(index.list().map((job) => job.pagesDone)).toEqual([2, 2])
    // A finished job can be dismissed; a running one cannot.
    expect(await index.dismiss(only(index).id)).toEqual({ ok: true })
    expect(index.list()).toHaveLength(1)
  })

  it('tells a search how indexing of its folder is going', async () => {
    await put(path.join(sb.root, 'rfi/s.pdf'), scans(2, 'Status'))
    ocr.battery = true
    const index = service()
    await index.start(folder('rfi'))
    await until(() => stateOf(index) === 'battery')
    expect(index.statusFor(sb.root)).toMatchObject({
      folder: path.join(sb.root, 'rfi'),
      state: 'battery',
    })
    expect(index.statusFor(path.join(sb.root, 'rfi', 'sub'))).not.toBeNull()
    expect(index.statusFor(sb.outside)).toBeNull()
  })
})

describe('search_files and background indexing', () => {
  const searchWith = (index: OcrIndexService | null, input: Record<string, unknown>) =>
    toolHarness(sb, {
      documents: reader,
      documentCache: cache,
      ocr,
      ocrPriority: priority,
      ...(index ? { ocrIndex: index } : {}),
    })
      .tool('search_files')
      .execute({ path: sb.root, ...input }, fakeContext().ctx)

  it('finds pages indexing read without reading them again', async () => {
    await put(path.join(sb.root, 'idx.pdf'), scans(3, 'Indexed'))
    const index = service()
    await index.start(folder())
    await until(() => stateOf(index) === 'finished')
    const runs = ocr.reads.length
    const r = await searchWith(index, { contentPattern: 'Indexed page 2', context: 0 })
    expect(r.content).toContain('idx.pdf (page 2, OCR): Indexed page 2')
    expect(ocr.reads).toHaveLength(runs)
    expect(r.content).not.toContain('indexed in the background')
  })

  it('waits for the page indexing is reading, so no page is read twice', async () => {
    await put(path.join(sb.root, 'both.pdf'), scans(4, 'Both'))
    const held = gate()
    ocr.before = async (_name, page) => {
      if (page === 1 && ocr.reads.length === 0) await held.wait
    }
    const index = service()
    await index.start(folder())
    await until(() => reader.calls.some((call) => call.view === 'raster'))
    const searching = searchWith(index, { contentPattern: 'Both page 4', context: 0 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    held.open()
    const r = await searching
    expect(r.content).toContain('both.pdf (page 4, OCR): Both page 4')
    await until(() => stateOf(index) === 'finished')
    expect(readsOf('both.pdf')).toEqual(pagesOf('both.pdf', 4))
  })

  it('says indexing is under way for the folder, with its progress', async () => {
    await put(path.join(sb.root, 'w.pdf'), scans(2, 'Waiting'))
    ocr.battery = true
    const index = service()
    await index.start(folder())
    await until(() => stateOf(index) === 'battery')
    const r = await searchWith(index, { contentPattern: 'nothing here', context: 0 })
    expect(r.content).toContain(
      `Scanned pages in ${sb.root} are being indexed in the background, paused until this PC is plugged in`,
    )
    expect(r.content).toContain('tell the user indexing is still under way')
  })

  it('suggests indexing to the user when many scanned pages are left and none is running', async () => {
    await put(path.join(sb.root, 'many.pdf'), scans(60, 'Many'))
    ocr.battery = true
    const r = await searchWith(null, { contentPattern: 'Many page 59', context: 0 })
    expect(r.content).toContain('60 scanned pages in this folder are still unread by OCR.')
    expect(r.content).toContain('“Index scanned documents”')
    expect(r.content).toContain('you cannot start it yourself')
    // A few pages left: no suggestion.
    await fs.rm(path.join(sb.root, 'many.pdf'))
    await put(path.join(sb.root, 'few.pdf'), scans(3, 'Few'))
    const few = await searchWith(null, { contentPattern: 'Few page 2', context: 0 })
    expect(few.content).not.toContain('Index scanned documents')
  })
})
