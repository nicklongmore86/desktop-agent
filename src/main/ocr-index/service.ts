// Background indexing of a folder's scanned PDF pages, started by the user from the Files panel
// (never by the agent, never on its own when a folder is granted). It reads the pages search_files
// would, the same way: the sandboxed reader renders each page (main never parses a PDF), the
// pinned ocr-text.exe reads it at low priority (verified before every run), and what is read is
// kept in the per-page document text cache, in page order, as a search keeps it. A search then
// finds those pages without reading them again. See docs/ocr-index.md.
//
// Searches come first (OcrPriority): while one reads documents, indexing starts nothing new and
// the pages it is reading finish and are kept. It pauses on battery power and goes on when the PC
// is plugged in. The cache is the progress: after a restart a job checks its folder again, which
// is quick for PDFs already read, and goes on with the pages left. Only which folders are being
// indexed, and whether each is paused, is kept besides (`stateFile`).
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { FileLocation } from '../../shared/ipc-files'
import type { OcrIndexJob, OcrIndexResult, OcrIndexState } from '../../shared/ipc-ocr-index'
import { DEFAULT_LIMITS as DOCUMENT_LIMITS } from '../documents/limits'
import type { SystemOcr } from '../documents/system-ocr'
import type { DocumentReader } from '../documents/types'
import { resolveLocation, rootId } from '../files/location'
import { isSecretName } from '../files/secret-names'
import type { AuditSink } from '../permissions/audit'
import type { PathGuard } from '../permissions/guard'
import { isInside, samePath } from '../permissions/paths'
import { readJsonFile, writeJsonFile } from '../storage/json-file'
import { DEFAULT_LIMITS as TOOL_LIMITS } from '../tools/deps'
import type {
  CachedText,
  DocumentFileKey,
  DocumentTextCacheLike,
  OcrPage,
} from '../tools/document-text-cache'
import type { OcrIndexNote, OcrPriority } from '../tools/ocr-priority'
import { openVerified, readBounded } from '../tools/safe-fs'
import { BUSY_RETRY_MS, extractForSearch, isCloudOnly, pause } from '../tools/search-documents'
import { newOcrRun, ocrDocument } from '../tools/search-ocr'
import { walk, type WalkEntry } from '../tools/walk'

/** What a job says in each state: fixed text, never a file name or anything from a document. */
export const OCR_INDEX_TEXT = {
  queued: 'Waiting for another folder’s indexing to finish.',
  checking: 'Finding scanned pages. Runs at low priority and pauses on battery power.',
  reading: 'Reading scanned pages at low priority. Searches come first.',
  waiting: 'Making way for a search, which comes first.',
  paused: 'Paused. Pages read so far are kept.',
  battery: 'Paused while this PC runs on battery power. It goes on when the PC is plugged in.',
  finished: 'Every scanned page that could be read has been read.',
  failed: 'Stopped: OCR failed on several pages in a row. Resume to try again.',
  broken: 'Stopped: something went wrong. Resume to try again.',
  capped: 'Only the first 50,000 entries of this folder were checked.',
} as const

/** Reasons a start is refused, written for the user. */
export const OCR_INDEX_REFUSAL = {
  notFolder: 'Only folders can be indexed.',
  gone: 'That folder no longer exists.',
  same: 'Scanned documents in this folder are already being indexed.',
  inside: 'This folder is inside a folder that is already being indexed.',
  holds: 'A folder inside this one is being indexed. Cancel that first, or let it finish.',
  unknown: 'That indexing job no longer exists.',
  notDone: 'Only finished or stopped indexing can be dismissed.',
  notPaused: 'That indexing is not paused.',
} as const

/** Tries at saving the jobs when Windows briefly refuses to replace the file. */
const STATE_WRITE_ATTEMPTS = 6

/** Folders never descended into, as search_files skips them. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

export interface OcrIndexLimits {
  /** Characters of one document's text kept, as search_files keeps them. */
  maxChars: number
  /** Reader calls for one document's text. */
  maxCalls: number
  /** Entries a job looks at in its folder. */
  maxEntries: number
  maxDepth: number
  /** One ocrDocument call's time: it then saves and goes on with the same document. */
  sliceMs: number
  /** How often a job that waits (battery, a search, the user) looks again. */
  pollMs: number
  /** Progress is pushed at most this often; state changes at once. */
  emitEveryMs: number
}

export const OCR_INDEX_LIMITS: OcrIndexLimits = {
  maxChars: TOOL_LIMITS.maxSearchDocumentChars,
  maxCalls: TOOL_LIMITS.maxSearchDocumentCalls,
  maxEntries: TOOL_LIMITS.maxSearchEntries,
  maxDepth: TOOL_LIMITS.maxSearchDepth,
  sliceMs: 10 * 60_000,
  pollMs: 1000,
  emitEveryMs: 500,
}

export interface OcrIndexDeps {
  guard: PathGuard
  reader: DocumentReader
  ocr: SystemOcr
  cache: DocumentTextCacheLike
  priority: OcrPriority
  audit: AuditSink
  /** Which folders are being indexed, and whether each is paused (userData/ocr-index.json). */
  stateFile: string
  /** The jobs, whenever they change. */
  emit: (jobs: OcrIndexJob[]) => void
  /** Whether the PC runs on battery; default: what the OCR says. */
  onBattery?: () => boolean
  /** Monotonic ms. */
  now?: () => number
  limits?: Partial<OcrIndexLimits>
}

/** A PDF with scanned pages, as a job last saw it. */
interface Doc {
  entry: WalkEntry
  /** The granted folder it is in (the innermost), which its cache entry is kept under. */
  root: string
  key: DocumentFileKey
  /** Its pages that need OCR. */
  total: number
  /** Of those, read or given up on for good. */
  processed: number
  /** Of those, given up on for good. */
  failed: number
  /** Pages that failed this run in a way worth trying again: still pending. */
  retry: number
  done: boolean
}

interface Job {
  id: string
  /** The granted folder the job's folder was named under. */
  root: string
  rel: string
  folder: string
  state: OcrIndexState
  paused: boolean
  message: string | null
  filesChecked: number
  filesTotal: number
  pagesTotal: number
  pagesDone: number
  cloudOnly: number
  skipped: number
  capped: boolean
  /** The checked PDFs with scanned pages, kept across a pause; null until checked. */
  docs: Doc[] | null
  /** Pages read this session, and the time spent reading them: the rate of the estimate. */
  readPages: number
  readMs: number
  sliceStart: number | null
  abort: AbortController
  /** When this run started (ms), for the audit's duration. */
  started: number
}

type Halt = 'paused' | 'cancelled' | 'gone'
/** What a job shows while it works. */
type Working = 'checking' | 'reading'
type Stop = { stop: string; reason: 'ocr-unavailable' | 'ocr-failed' }

const stateSchema = z.object({
  version: z.literal(1),
  jobs: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9a-f]{16}$/),
        root: z.string().min(1).max(4096),
        rel: z.string().max(4096),
        paused: z.boolean(),
      }),
    )
    .max(64),
})

const ACTIVE: ReadonlySet<OcrIndexState> = new Set([
  'queued',
  'checking',
  'reading',
  'waiting',
  'paused',
  'battery',
])

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const isPending = (page: OcrPage): boolean => page.state === 'pending'

export type OcrIndexService = ReturnType<typeof createOcrIndexService>

/** The app's background indexing of scanned pages: one job runs at a time, the others queue. */
export function createOcrIndexService(deps: OcrIndexDeps) {
  const { guard, cache, priority, ocr } = deps
  const limits: OcrIndexLimits = { ...OCR_INDEX_LIMITS, ...deps.limits }
  const now = deps.now ?? (() => performance.now())
  const onBattery = deps.onBattery ?? (() => ocr.onBattery?.() === true)
  const platform = guard.platform
  const jobs: Job[] = []
  let loop: Promise<void> | null = null
  let disposed = false
  let emitTimer: ReturnType<typeof setTimeout> | null = null
  let saving: Promise<void> = Promise.resolve()

  // --- What the renderer and a search see -------------------------------------------------

  const minutesLeft = (job: Job): number | null => {
    const ms = job.readMs + (job.sliceStart === null ? 0 : now() - job.sliceStart)
    const left = job.pagesTotal - job.pagesDone
    if (job.readPages < 2 || ms <= 0 || left <= 0 || job.docs === null) return null
    return Math.max(1, Math.ceil(left / (job.readPages / ms) / 60_000))
  }

  const failedOf = (job: Job): number =>
    (job.docs ?? []).reduce((sum, doc) => sum + doc.failed + doc.retry, 0)

  const view = (job: Job): OcrIndexJob => ({
    id: job.id,
    rootId: rootId(job.root),
    rel: job.rel,
    name: guard.path.basename(job.folder) || job.folder,
    path: job.folder,
    state: job.state,
    filesChecked: job.filesChecked,
    filesTotal: job.filesTotal,
    pagesDone: job.pagesDone,
    pagesTotal: job.pagesTotal,
    pagesFailed: failedOf(job),
    minutesLeft: ACTIVE.has(job.state) ? minutesLeft(job) : null,
    cloudOnly: job.cloudOnly,
    skipped: job.skipped,
    message: job.message,
  })

  const list = (): OcrIndexJob[] => jobs.map(view)

  const emitNow = (): void => {
    if (emitTimer) clearTimeout(emitTimer)
    emitTimer = null
    if (!disposed) deps.emit(list())
  }
  /** Pushes the jobs: at once for a new state, else at most every emitEveryMs. */
  const changed = (immediate = false): void => {
    if (immediate) emitNow()
    else emitTimer ??= setTimeout(emitNow, limits.emitEveryMs)
  }

  const setState = (job: Job, state: OcrIndexState, message: string | null = null): void => {
    if (job.state === state && job.message === message) return
    job.state = state
    job.message = message
    changed(true)
  }

  // --- Kept between runs, and recorded ------------------------------------------------------

  /**
   * Writes the state file. On Windows, replacing a file another process has open (antivirus,
   * a backup, an indexer) fails for a moment with EPERM, EBUSY or EACCES: tried again a few times.
   */
  const writeState = async (value: unknown): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await writeJsonFile(deps.stateFile, value)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const passing = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (!passing || attempt >= STATE_WRITE_ATTEMPTS) throw error
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
      }
    }
  }

  const persist = (): Promise<void> => {
    const value = {
      version: 1 as const,
      jobs: jobs
        .filter((job) => ACTIVE.has(job.state))
        .map((job) => ({ id: job.id, root: job.root, rel: job.rel, paused: job.paused })),
    }
    saving = saving
      .then(() => writeState(value))
      .catch((error: unknown) => {
        console.error('ocr index: could not save its jobs', error)
      })
    return saving
  }

  /** Counts only: no file name, and nothing read from a document. */
  const record = (job: Job, event: 'start' | 'stop' | 'complete', extra: object = {}) => {
    const counts = {
      event,
      ...extra,
      filesChecked: job.filesChecked,
      filesTotal: job.filesTotal,
      pagesDone: job.pagesDone,
      pagesTotal: job.pagesTotal,
      pagesReadThisRun: job.readPages,
      pagesFailed: failedOf(job),
      cloudOnly: job.cloudOnly,
      skipped: job.skipped,
    }
    deps.audit
      .record({
        tool: 'ocr_index',
        args: counts,
        paths: [job.folder],
        approval: 'not-requested',
        origin: 'user',
        outcome: 'ok',
        durationMs: Math.max(0, Math.round(now() - job.started)),
      })
      .catch((error: unknown) => {
        console.error('ocr index: could not record to the audit log', error)
      })
  }

  // --- Running --------------------------------------------------------------------------------

  /** Whether a job was cancelled or the app is quitting (a function: it changes across awaits). */
  const ended = (job: Job): boolean => job.abort.signal.aborted || disposed

  const isGranted = (root: string): boolean =>
    guard.grantedRoots().some((granted) => samePath(granted, root, platform))

  /** The granted folder a file is in: the innermost, as search_files keys the cache. */
  const grantRootOf = (file: string): string | null => {
    let best: string | null = null
    for (const root of guard.grantedRoots()) {
      if (isInside(file, root, platform) && (best === null || root.length > best.length)) {
        best = root
      }
    }
    return best
  }

  /**
   * Waits until the job may do its next piece of work: not paused, on mains power, and no
   * search reading documents. `active` is the state it then shows.
   */
  const turn = async (job: Job, active: Working): Promise<Halt | 'go'> => {
    const { signal } = job.abort
    for (;;) {
      if (ended(job)) return 'cancelled'
      if (!isGranted(job.root)) return 'gone'
      if (job.paused) return 'paused'
      if (onBattery()) setState(job, 'battery', OCR_INDEX_TEXT.battery)
      else if (priority.searching) setState(job, 'waiting', OCR_INDEX_TEXT.waiting)
      else {
        setState(job, active, job.capped ? OCR_INDEX_TEXT.capped : OCR_INDEX_TEXT[active])
        return 'go'
      }
      const stopWaiting = new AbortController()
      const waits = [pause(limits.pollMs, signal)]
      if (job.state === 'waiting') {
        waits.push(priority.whenFree(AbortSignal.any([signal, stopWaiting.signal])))
      }
      await Promise.race(waits)
      stopWaiting.abort()
    }
  }

  /**
   * An abort signal for the job's reader work that also fires when the job must make way
   * (a search, the user's pause), so a long document's text does not hold the reader.
   */
  const yielding = (job: Job): { signal: AbortSignal; done: () => void } => {
    const stop = new AbortController()
    const timer = setInterval(
      () => {
        if (priority.searching || job.paused) stop.abort()
      },
      Math.min(250, limits.pollMs),
    )
    return {
      signal: AbortSignal.any([job.abort.signal, stop.signal]),
      done: () => {
        clearInterval(timer)
      },
    }
  }

  /** A file's bytes, with the cache key and grant token they are kept under. */
  const readFile = async (
    entry: WalkEntry,
    root: string,
  ): Promise<
    { bytes: Buffer; key: DocumentFileKey; token: string | null } | 'cloud-only' | 'skipped'
  > => {
    // Taken before the file is read: a grant removed since (even if granted again) keeps nothing.
    const token = cache.token(root)
    try {
      const { handle, stats } = await openVerified(guard, entry.path, 'read', entry.id)
      let bytes: Buffer
      try {
        if (stats.size > BigInt(DOCUMENT_LIMITS.maxDocumentBytes)) return 'skipped'
        // What the walk saw may have changed since: reading it now would download it.
        if (
          isCloudOnly(
            { path: entry.path, size: Number(stats.size), blocks: stats.blocks },
            platform,
          )
        ) {
          return 'cloud-only'
        }
        bytes = await readBounded(handle, Number(stats.size))
      } finally {
        await handle.close()
      }
      const key: DocumentFileKey = {
        root,
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
      }
      return { bytes, key, token }
    } catch {
      return 'skipped'
    }
  }

  /** A document's text through the reader, kept in the cache; asked again while it is busy. */
  const extract = async (
    job: Job,
    entry: WalkEntry,
    file: { bytes: Buffer; key: DocumentFileKey; token: string | null },
    active: Working,
  ): Promise<CachedText | Halt> => {
    for (;;) {
      const go = await turn(job, active)
      if (go !== 'go') return go
      const end = now() + limits.sliceMs
      const making = yielding(job)
      const outcome = await extractForSearch(
        deps.reader,
        file.bytes,
        entry.name,
        { maxChars: limits.maxChars, maxCalls: limits.maxCalls },
        () => Math.max(0, end - now()),
        making.signal,
      ).finally(making.done)
      if (outcome.kind === 'stopped') {
        if (job.abort.signal.aborted) return 'cancelled'
        if (outcome.why === 'busy') await pause(BUSY_RETRY_MS, job.abort.signal)
        continue
      }
      if (outcome.cacheable && file.token !== null && guard.blockedReason(entry.path) === null) {
        await cache.put(file.key, outcome.text, file.token)
      }
      return outcome.text
    }
  }

  /** Counts a document's pages into the job, from its text as now kept. */
  const tally = (job: Job, doc: Doc, text: CachedText): void => {
    const total = text.ocr.length
    const processed = text.ocr.filter((page) => !isPending(page)).length
    const failed = text.ocr.filter((page) => page.state === 'failed').length
    job.pagesTotal += total - doc.total
    const read = processed - doc.processed
    job.pagesDone += read
    if (read > 0 && job.sliceStart !== null) job.readPages += read
    doc.total = total
    doc.processed = processed
    doc.failed = failed
    changed()
  }

  /** Leaves a document out: its pages left are no longer counted. */
  const leaveOut = (job: Job, doc: Doc, why: 'cloud-only' | 'skipped'): void => {
    job.pagesTotal -= doc.total - doc.processed
    doc.total = doc.processed
    doc.retry = 0
    doc.done = true
    if (why === 'cloud-only') job.cloudOnly++
    else job.skipped++
    changed()
  }

  /** Finds the folder's PDFs and which of their pages need OCR (each PDF's text read once). */
  const survey = async (job: Job): Promise<Halt | 'go'> => {
    const { signal } = job.abort
    Object.assign(job, {
      filesChecked: 0,
      filesTotal: 0,
      pagesTotal: 0,
      pagesDone: 0,
      cloudOnly: 0,
      skipped: 0,
      capped: false,
    })
    const go = await turn(job, 'checking')
    if (go !== 'go') return go
    const found: WalkEntry[] = []
    let visited = 0
    for await (const entry of walk(job.folder, guard, {
      maxDepth: limits.maxDepth,
      signal,
      skipDirs: SKIPPED_DIRS,
    })) {
      if (++visited > limits.maxEntries) {
        job.capped = true
        setState(job, 'checking', OCR_INDEX_TEXT.capped)
        break
      }
      if (entry.kind !== 'file' || extensionOf(entry.name) !== 'pdf') continue
      // A name like credentials.pdf is never sent through the reader, as in a search.
      if (
        isSecretName(entry.name) ||
        entry.nlink > 1 ||
        entry.size > DOCUMENT_LIMITS.maxDocumentBytes
      ) {
        job.skipped++
      } else if (isCloudOnly(entry, platform)) {
        // Never downloaded: reading a placeholder would fetch it from the cloud.
        job.cloudOnly++
      } else {
        found.push(entry)
        job.filesTotal = found.length
      }
      changed()
    }
    if (signal.aborted) return 'cancelled'
    const docs: Doc[] = []
    for (const entry of found) {
      const go = await turn(job, 'checking')
      if (go !== 'go') return go
      const doc = await check(job, entry)
      if (doc === 'paused' || doc === 'cancelled' || doc === 'gone') return doc
      job.filesChecked++
      if (doc) docs.push(doc)
      changed()
    }
    job.docs = docs
    return 'go'
  }

  /** One PDF's scanned pages, from the cache or read now; null when it has none to read. */
  const check = async (job: Job, entry: WalkEntry): Promise<Doc | Halt | null> => {
    const root = grantRootOf(entry.path)
    if (root === null) {
      job.skipped++
      return null
    }
    let key: DocumentFileKey = {
      root,
      dev: entry.id.dev,
      ino: entry.id.ino,
      size: BigInt(entry.size),
      mtimeNs: entry.mtimeNs,
      ctimeNs: entry.ctimeNs,
    }
    let text = cache.has(key) ? await cache.get(key) : null
    if (!text) {
      const file = await readFile(entry, root)
      if (file === 'cloud-only') {
        job.cloudOnly++
        return null
      }
      if (file === 'skipped') {
        job.skipped++
        return null
      }
      const read = await extract(job, entry, file, 'checking')
      if (typeof read === 'string') return read
      text = read
      key = file.key
    }
    if (text.failure !== null) {
      job.skipped++
      return null
    }
    if (text.ocr.length === 0) return null
    const doc: Doc = { entry, root, key, total: 0, processed: 0, failed: 0, retry: 0, done: false }
    tally(job, doc, text)
    doc.done = doc.processed === doc.total
    return doc
  }

  /**
   * OCR of one document's pending pages, from its bytes read again through a checked handle
   * and its text as the cache holds it now (a search may have read some of its pages).
   * 'next': on to the next document; 'again': the same one, after the job's next turn.
   */
  const readDoc = async (job: Job, doc: Doc): Promise<'next' | 'again' | Halt | Stop> => {
    const file = await readFile(doc.entry, doc.root)
    if (file === 'cloud-only' || file === 'skipped') {
      leaveOut(job, doc, file)
      return 'next'
    }
    let text = await cache.get(file.key)
    if (!text) {
      // Changed since it was checked, or gone from the cache: its text is read again.
      const read = await extract(job, doc.entry, file, 'reading')
      if (typeof read === 'string') return read
      text = read
      if (text.failure !== null) {
        leaveOut(job, doc, 'skipped')
        return 'next'
      }
    }
    doc.key = file.key
    tally(job, doc, text)
    doc.retry = 0
    if (!text.ocr.some(isPending)) return 'next'
    const go = await turn(job, 'reading')
    if (go !== 'go') return go
    const token = file.token
    const path = doc.entry.path
    const run = newOcrRun()
    const end = now() + limits.sliceMs
    job.sliceStart = now()
    const current = text
    const result = await priority
      .track(
        ocrDocument({
          reader: deps.reader,
          ocr,
          bytes: file.bytes,
          name: doc.entry.name,
          text: current,
          maxChars: limits.maxChars,
          timeLeft: () => Math.max(0, end - now()),
          now,
          signal: job.abort.signal,
          stillGranted: () => token !== null && cache.token(doc.root) === token,
          pauseWhen: () => priority.searching || job.paused || disposed,
          keep: async (value) => {
            const kept =
              token !== null &&
              guard.blockedReason(path) === null &&
              (await cache.put(file.key, value, token))
            if (kept) tally(job, doc, value)
            return kept
          },
          run,
        }),
      )
      .finally(() => {
        if (job.sliceStart !== null) job.readMs += now() - job.sliceStart
        job.sliceStart = null
      })
    doc.retry = result.failedNow.size
    changed()
    switch (result.outcome) {
      case 'finished':
        return 'next'
      case 'paused':
      case 'time':
        // What was read is kept: the rest on the next turn. Not kept (the cache refused
        // it: too big), it would only be read again, so the job goes on to the next.
        return result.kept ? 'again' : 'next'
      case 'cancelled':
        return 'cancelled'
      case 'gone':
        // This file's grant went (a nested one): the job's own folder is checked next turn.
        return 'next'
      case 'off':
        if (run.off === 'on-battery') return 'again'
        if (run.off === 'failed') return { stop: OCR_INDEX_TEXT.failed, reason: 'ocr-failed' }
        return { stop: run.offMessage ?? OCR_INDEX_TEXT.broken, reason: 'ocr-unavailable' }
    }
  }

  const stopJob = (job: Job, message: string, reason: string): void => {
    setState(job, 'stopped', message)
    record(job, 'stop', { reason })
    void persist()
  }

  /** Where a job that stopped waiting for its turn ends up. */
  const halt = (job: Job, why: Halt): void => {
    if (why === 'paused') {
      setState(job, 'paused', OCR_INDEX_TEXT.paused)
      record(job, 'stop', { reason: 'paused' })
      void persist()
    } else if (why === 'gone') {
      void forget(job, 'grant-removed')
    }
    // 'cancelled': cancel() or dispose() already did what there is to do.
  }

  const runJob = async (job: Job): Promise<void> => {
    job.started = now()
    await cache.load()
    const availability = await ocr.probe({ refresh: true })
    if (ended(job)) return
    if (!availability.available) {
      stopJob(job, availability.message, 'ocr-unavailable')
      return
    }
    if (job.docs === null) {
      const surveyed = await survey(job)
      if (surveyed !== 'go') {
        halt(job, surveyed)
        return
      }
    }
    for (const doc of job.docs ?? []) {
      while (!doc.done) {
        const go = await turn(job, 'reading')
        if (go !== 'go') {
          halt(job, go)
          return
        }
        const outcome = await readDoc(job, doc)
        if (outcome === 'next') doc.done = true
        else if (outcome === 'again') continue
        else if (typeof outcome === 'string') {
          halt(job, outcome)
          return
        } else {
          stopJob(job, outcome.stop, outcome.reason)
          return
        }
      }
    }
    if (ended(job)) return
    setState(
      job,
      'finished',
      job.capped ? `${OCR_INDEX_TEXT.finished} ${OCR_INDEX_TEXT.capped}` : OCR_INDEX_TEXT.finished,
    )
    record(job, 'complete')
    void persist()
  }

  /** Runs the queued jobs one after the other. */
  const kick = (): void => {
    if (loop || disposed) return
    loop = (async () => {
      const next = (): Job | undefined =>
        disposed ? undefined : jobs.find((j) => j.state === 'queued')
      for (let job = next(); job; job = next()) {
        try {
          await runJob(job)
        } catch (error) {
          console.error('ocr index: a job failed', error)
          if (ACTIVE.has(job.state) && !ended(job)) {
            stopJob(job, OCR_INDEX_TEXT.broken, 'error')
          }
        }
      }
    })().finally(() => {
      loop = null
      if (!disposed && jobs.some((j) => j.state === 'queued')) kick()
    })
  }

  // --- Controls -------------------------------------------------------------------------------

  const newJob = (id: string, root: string, rel: string, folder: string, paused: boolean): Job => ({
    id,
    root,
    rel,
    folder,
    state: paused ? 'paused' : 'queued',
    paused,
    message: paused ? OCR_INDEX_TEXT.paused : OCR_INDEX_TEXT.queued,
    filesChecked: 0,
    filesTotal: 0,
    pagesTotal: 0,
    pagesDone: 0,
    cloudOnly: 0,
    skipped: 0,
    capped: false,
    docs: null,
    readPages: 0,
    readMs: 0,
    sliceStart: null,
    abort: new AbortController(),
    started: now(),
  })

  const find = (id: string): Job | undefined => jobs.find((job) => job.id === id)

  /** Ends a job for good and takes it off the list. */
  const forget = async (job: Job, reason: string): Promise<void> => {
    job.abort.abort()
    const at = jobs.indexOf(job)
    if (at < 0) return
    jobs.splice(at, 1)
    if (ACTIVE.has(job.state)) record(job, 'stop', { reason })
    changed(true)
    await persist()
  }

  const overlap = (folder: string): OcrIndexResult | null => {
    for (const job of jobs) {
      if (!ACTIVE.has(job.state)) continue
      if (samePath(job.folder, folder, platform))
        return { ok: false, reason: OCR_INDEX_REFUSAL.same }
      if (isInside(folder, job.folder, platform)) {
        return { ok: false, reason: OCR_INDEX_REFUSAL.inside }
      }
      if (isInside(job.folder, folder, platform)) {
        return { ok: false, reason: OCR_INDEX_REFUSAL.holds }
      }
    }
    return null
  }

  const isFolder = async (path: string): Promise<boolean> => {
    try {
      return (await fs.lstat(path)).isDirectory()
    } catch {
      return false
    }
  }

  return {
    list,

    async start(location: FileLocation): Promise<OcrIndexResult> {
      const where = await resolveLocation(guard, location)
      if (!where.ok) return { ok: false, reason: where.reason }
      if (!where.exists) return { ok: false, reason: OCR_INDEX_REFUSAL.gone }
      if (!(await isFolder(where.path))) return { ok: false, reason: OCR_INDEX_REFUSAL.notFolder }
      const clash = overlap(where.path)
      if (clash) return clash
      const availability = await ocr.probe()
      if (!availability.available) return { ok: false, reason: availability.message }
      // A finished or stopped job for the same folder makes way for the new one.
      for (const old of jobs.filter((job) => samePath(job.folder, where.path, platform))) {
        jobs.splice(jobs.indexOf(old), 1)
      }
      const job = newJob(
        randomBytes(8).toString('hex'),
        where.root,
        location.rel,
        where.path,
        false,
      )
      jobs.push(job)
      record(job, 'start')
      changed(true)
      await persist()
      kick()
      return { ok: true }
    },

    pause(id: string): Promise<OcrIndexResult> {
      const job = find(id)
      if (!job) return Promise.resolve({ ok: false, reason: OCR_INDEX_REFUSAL.unknown })
      if (!ACTIVE.has(job.state)) return Promise.resolve({ ok: true })
      job.paused = true
      // A running job pauses once its pages being read are kept (halt() says so then).
      if (job.state === 'queued') {
        setState(job, 'paused', OCR_INDEX_TEXT.paused)
        record(job, 'stop', { reason: 'paused' })
      }
      return persist().then(() => ({ ok: true }))
    },

    resume(id: string): Promise<OcrIndexResult> {
      const job = find(id)
      if (!job) return Promise.resolve({ ok: false, reason: OCR_INDEX_REFUSAL.unknown })
      if (job.state !== 'paused' && job.state !== 'stopped') {
        // Pausing, not yet paused: it simply goes on.
        job.paused = false
        return Promise.resolve({ ok: true })
      }
      job.paused = false
      job.abort = new AbortController()
      // A stopped job checks its folder again: OCR may work now, or files may have changed.
      if (job.state === 'stopped') job.docs = null
      job.readPages = 0
      job.readMs = 0
      job.started = now()
      setState(job, 'queued', OCR_INDEX_TEXT.queued)
      record(job, 'start', { resumed: true })
      kick()
      return persist().then(() => ({ ok: true }))
    },

    async cancel(id: string): Promise<OcrIndexResult> {
      const job = find(id)
      if (!job) return { ok: false, reason: OCR_INDEX_REFUSAL.unknown }
      await forget(job, 'cancelled')
      return { ok: true }
    },

    dismiss(id: string): Promise<OcrIndexResult> {
      const job = find(id)
      if (!job) return Promise.resolve({ ok: false, reason: OCR_INDEX_REFUSAL.unknown })
      if (ACTIVE.has(job.state)) {
        return Promise.resolve({ ok: false, reason: OCR_INDEX_REFUSAL.notDone })
      }
      jobs.splice(jobs.indexOf(job), 1)
      changed(true)
      return persist().then(() => ({ ok: true }))
    },

    /**
     * Takes up the jobs saved when the app last ran, for folders still granted, and starts
     * those not paused. Their progress is the cache's.
     */
    async load(): Promise<void> {
      let raw: unknown
      try {
        raw = await readJsonFile(deps.stateFile)
      } catch (error) {
        console.error('ocr index: could not read its jobs', error)
        return
      }
      const parsed = stateSchema.safeParse(raw)
      if (!parsed.success) return
      for (const saved of parsed.data.jobs) {
        if (find(saved.id) || !isGranted(saved.root)) continue
        const where = await resolveLocation(guard, { rootId: rootId(saved.root), rel: saved.rel })
        if (!where.ok || !where.exists || !(await isFolder(where.path))) continue
        if (overlap(where.path)) continue
        const job = newJob(saved.id, where.root, saved.rel, where.path, saved.paused)
        jobs.push(job)
        if (!saved.paused) record(job, 'start', { resumed: true, afterRestart: true })
      }
      changed(true)
      await persist()
      kick()
    },

    /** The grant of `root` was removed: its jobs end (the cache has deleted what they read). */
    async forgetGrant(root: string): Promise<void> {
      for (const job of jobs.filter(
        (j) => samePath(j.root, root, platform) || isInside(j.folder, root, platform),
      )) {
        await forget(job, 'grant-removed')
      }
    },

    /** On quit: stops every job where it is, keeping them for the next start. */
    async dispose(): Promise<void> {
      disposed = true
      if (emitTimer) clearTimeout(emitTimer)
      for (const job of jobs) job.abort.abort()
      await loop?.catch(() => undefined)
      await saving
    },

    /** For search_files: indexing still under way for a folder inside `dir`, or holding it. */
    statusFor(dir: string): OcrIndexNote | null {
      const job = jobs.find(
        (j) =>
          ACTIVE.has(j.state) &&
          (isInside(dir, j.folder, platform) || isInside(j.folder, dir, platform)),
      )
      if (!job) return null
      return {
        folder: job.folder,
        state: job.state as OcrIndexNote['state'],
        filesChecked: job.filesChecked,
        filesTotal: job.filesTotal,
        pagesDone: job.pagesDone,
        pagesTotal: job.pagesTotal,
        minutesLeft: minutesLeft(job),
      }
    },
  }
}
