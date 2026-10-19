import { app, BrowserWindow, MessageChannelMain, session, type MessagePortMain } from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { secureWebPreferences } from '../security'
import { checkDocumentSize, DEFAULT_LIMITS, type DocumentLimits } from './limits'
import { WORKER_PORT_CHANNEL, type FromWorker, type ToWorker } from './protocol'
import {
  DocumentError,
  type DocumentErrorCode,
  type DocumentView,
  type ExtractOptions,
} from './types'

/**
 * Runs document parsing in a hidden, sandboxed BrowserWindow: no Node, an in-memory
 * session of its own whose every request except the worker's own bundled files is
 * cancelled, and a CSP that allows only its own script and WASM. Bytes go in and
 * results come out over a MessagePort. Each job has a wall-clock timeout and a memory
 * ceiling, after which the window is destroyed; workers are recycled after a number of
 * jobs and shut down when idle. A new worker starts in roughly 150 ms.
 */

export interface DocumentWorkerOptions {
  /** The built worker page: out/document-worker. */
  workerDir: string
  /** Its preload: out/preload/document-worker.js. */
  preloadPath: string
  limits?: DocumentLimits
  timeoutMs?: number
  /** Working set above which a running job is killed; above 3/4 of it the worker is recycled. */
  memoryLimitBytes?: number
  maxJobsPerWorker?: number
  idleMs?: number
  partition?: string
}

/** Where the worker's files are in a build: beside out/main, inside app.asar when packaged. */
export function documentWorkerPaths(mainDir: string): { workerDir: string; preloadPath: string } {
  return {
    workerDir: join(mainDir, '../document-worker'),
    preloadPath: join(mainDir, '../preload/document-worker.js'),
  }
}

/** True only for file: URLs inside the worker's own build directory. */
export function isWorkerRequestAllowed(url: string, workerDir: string): boolean {
  let path: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' || parsed.search) return false
    path = fileURLToPath(parsed)
  } catch {
    return false
  }
  const inside = relative(resolve(workerDir), resolve(path))
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

const START_TIMEOUT_MS = 10_000
const MEMORY_POLL_MS = 250

const regionSchema = z.object({
  page: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})
const shortText = z.string().max(10_000)
/** The worker parses hostile files, so its answers are checked before anyone uses them. */
const viewSchema = z.object({
  meta: z.object({
    kind: z.string().max(20),
    mime: z.string().max(200),
    name: z.string().max(1000).optional(),
    pageCount: z.number().int().nonnegative().optional(),
    width: z.number().nonnegative().optional(),
    height: z.number().nonnegative().optional(),
    title: shortText.optional(),
    author: shortText.optional(),
  }),
  sections: z
    .array(
      z.object({
        page: z.number().int().positive().optional(),
        title: shortText.optional(),
        text: z.string(),
      }),
    )
    .max(1000),
  images: z
    .array(
      z.object({
        bytes: z.instanceof(Uint8Array),
        mime: z.enum(['image/png', 'image/jpeg']),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        source: z.object({
          page: z.number().int().positive().optional(),
          region: regionSchema.optional(),
        }),
      }),
    )
    .max(100),
  position: z.object({
    unit: z.enum(['page', 'char', 'image']),
    total: z.number().int().nonnegative(),
    shown: z.object({ from: z.number().int(), to: z.number().int() }),
    next: z.number().int().positive().nullable(),
  }),
  warnings: z.array(shortText).max(100),
})
const ERROR_CODES = new Set<string>([
  'too-large',
  'too-many-pixels',
  'password-protected',
  'malformed',
  'unsupported',
  'out-of-range',
  'zip-bomb',
])

interface Job {
  id: number
  resolve: (view: DocumentView) => void
  reject: (error: DocumentError) => void
}

interface Worker {
  window: BrowserWindow
  port: MessagePortMain
  jobs: number
  pending: Job | null
  dead: boolean
}

export class DocumentWorkerHost {
  private readonly limits: DocumentLimits
  private readonly timeoutMs: number
  private readonly memoryLimitBytes: number
  private readonly maxJobsPerWorker: number
  private readonly idleMs: number
  private readonly partition: string
  private worker: Promise<Worker> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private wasm: Promise<Uint8Array> | null = null
  private hardened = false
  private idleTimer: NodeJS.Timeout | null = null
  private nextId = 0
  private counters = { workersStarted: 0, jobs: 0, lastStartMs: 0 }

  constructor(private readonly options: DocumentWorkerOptions) {
    this.limits = options.limits ?? DEFAULT_LIMITS
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.memoryLimitBytes = options.memoryLimitBytes ?? 1536 * 1024 * 1024
    this.maxJobsPerWorker = options.maxJobsPerWorker ?? 25
    this.idleMs = options.idleMs ?? 60_000
    this.partition = options.partition ?? 'document-worker'
  }

  /** Reads one document. Jobs run one at a time; a failure never affects the next job. */
  extract(bytes: Uint8Array, options: ExtractOptions = {}): Promise<DocumentView> {
    checkDocumentSize(bytes.length, this.limits)
    // A copy of exactly these bytes: a Buffer's view may sit in a shared pool.
    const copy = new Uint8Array(bytes)
    const run = this.queue.then(() => this.run(copy, options))
    this.queue = run.catch(() => undefined)
    return run
  }

  stats(): { workersStarted: number; jobs: number; lastStartMs: number } {
    return { ...this.counters }
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const worker = await this.worker?.catch(() => null)
    if (worker) this.kill(worker)
    this.worker = null
  }

  private async run(bytes: Uint8Array, options: ExtractOptions): Promise<DocumentView> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const worker = await this.currentWorker()
    try {
      return await this.dispatch(worker, bytes, options)
    } finally {
      this.counters.jobs++
      worker.jobs++
      if (
        !worker.dead &&
        (worker.jobs >= this.maxJobsPerWorker ||
          this.memoryOf(worker) > this.memoryLimitBytes * 0.75)
      ) {
        this.kill(worker)
      }
      if (!worker.dead) {
        this.idleTimer = setTimeout(() => {
          this.kill(worker)
        }, this.idleMs)
      }
    }
  }

  private currentWorker(): Promise<Worker> {
    const current = this.worker
    if (current) {
      return current.then((worker) => (worker.dead ? this.replaceWorker() : worker))
    }
    return this.replaceWorker()
  }

  private replaceWorker(): Promise<Worker> {
    const next = this.startWorker()
    this.worker = next
    next.catch(() => {
      if (this.worker === next) this.worker = null
    })
    return next
  }

  private loadWasm(): Promise<Uint8Array> {
    this.wasm ??= (async () => {
      const assets = join(this.options.workerDir, 'assets')
      const name = (await readdir(assets)).find((file) => file.endsWith('.wasm'))
      if (!name) throw new Error('The document worker build has no WASM file')
      return new Uint8Array(await readFile(join(assets, name)))
    })()
    this.wasm.catch(() => {
      this.wasm = null
    })
    return this.wasm
  }

  private hardenSession(): Electron.Session {
    const ses = session.fromPartition(this.partition)
    if (this.hardened) return ses
    this.hardened = true
    ses.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    ses.setPermissionCheckHandler(() => false)
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isWorkerRequestAllowed(details.url, this.options.workerDir) })
    })
    ses.on('will-download', (event) => {
      event.preventDefault()
    })
    return ses
  }

  private async startWorker(): Promise<Worker> {
    const started = Date.now()
    const wasm = await this.loadWasm()
    this.hardenSession()
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        ...secureWebPreferences(this.options.preloadPath),
        partition: this.partition,
        backgroundThrottling: false,
        devTools: !app.isPackaged,
      },
    })
    const page = pathToFileURL(join(this.options.workerDir, 'index.html')).href
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const blockNavigation = (event: Electron.Event, target: string): void => {
      if (target !== page) event.preventDefault()
    }
    contents.on('will-navigate', blockNavigation)
    contents.on('will-redirect', blockNavigation)
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    const { port1, port2 } = new MessageChannelMain()
    const worker: Worker = { window, port: port1, jobs: 0, pending: null, dead: false }
    contents.on('render-process-gone', () => {
      this.abort(worker, 'worker-failed', 'The document reader stopped unexpectedly.')
    })
    window.on('closed', () => {
      worker.dead = true
    })

    try {
      await window.loadURL(page)
      const ready = new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
          rejectReady(new Error('The document worker did not start'))
        }, START_TIMEOUT_MS)
        port1.on('message', ({ data }: { data: FromWorker }) => {
          if (data.type === 'ready') {
            clearTimeout(timer)
            resolveReady()
          } else if (data.type === 'init-failed') {
            clearTimeout(timer)
            rejectReady(new Error(`The document worker failed to start: ${data.message}`))
          } else {
            this.settle(worker, data)
          }
        })
      })
      port1.start()
      contents.postMessage(WORKER_PORT_CHANNEL, null, [port2])
      this.send(worker, { type: 'init', wasm })
      await ready
    } catch (error) {
      this.kill(worker)
      throw new DocumentError(
        'worker-failed',
        error instanceof Error ? error.message : 'The document worker did not start',
      )
    }
    this.counters.workersStarted++
    this.counters.lastStartMs = Date.now() - started
    return worker
  }

  private send(worker: Worker, message: ToWorker): void {
    worker.port.postMessage(message)
  }

  private dispatch(
    worker: Worker,
    bytes: Uint8Array,
    options: ExtractOptions,
  ): Promise<DocumentView> {
    return new Promise<DocumentView>((resolveJob, rejectJob) => {
      const id = ++this.nextId
      const timeout = setTimeout(() => {
        this.abort(
          worker,
          'timeout',
          `Reading the document took longer than ${String(this.timeoutMs / 1000)} seconds.`,
        )
      }, this.timeoutMs)
      const memory = setInterval(() => {
        if (this.memoryOf(worker) > this.memoryLimitBytes) {
          this.abort(worker, 'memory', 'Reading the document needed more memory than is allowed.')
        }
      }, MEMORY_POLL_MS)
      const done = (): void => {
        clearTimeout(timeout)
        clearInterval(memory)
      }
      worker.pending = {
        id,
        resolve: (view) => {
          done()
          resolveJob(view)
        },
        reject: (error) => {
          done()
          rejectJob(error)
        },
      }
      if (worker.dead) {
        this.abort(worker, 'worker-failed', 'The document reader stopped unexpectedly.')
        return
      }
      this.send(worker, { type: 'extract', id, bytes, options, limits: this.limits })
    })
  }

  private abort(worker: Worker, code: DocumentErrorCode, message: string): void {
    const job = worker.pending
    worker.pending = null
    this.kill(worker)
    job?.reject(new DocumentError(code, message))
  }

  private settle(worker: Worker, data: FromWorker): void {
    const job = worker.pending
    if (!job || !('id' in data) || data.id !== job.id) return
    worker.pending = null
    if (data.type === 'result') {
      const parsed = viewSchema.safeParse(data.view)
      if (parsed.success) job.resolve(data.view)
      else
        job.reject(
          new DocumentError('worker-failed', 'The document reader returned an invalid result.'),
        )
      return
    }
    const code = ERROR_CODES.has(data.code) ? data.code : 'worker-failed'
    const message = typeof data.message === 'string' ? data.message.slice(0, 1000) : ''
    job.reject(new DocumentError(code, message || 'The document could not be read.'))
  }

  /** Bytes in the worker's renderer process working set (0 if it has none). */
  private memoryOf(worker: Worker): number {
    if (worker.dead || worker.window.isDestroyed()) return 0
    const pid = worker.window.webContents.getOSProcessId()
    const metric = app.getAppMetrics().find((entry) => entry.pid === pid)
    return (metric?.memory.workingSetSize ?? 0) * 1024
  }

  private kill(worker: Worker): void {
    if (worker.dead) return
    worker.dead = true
    worker.port.close()
    if (!worker.window.isDestroyed()) {
      // Crash first: a renderer stuck in a WASM loop won't unload on its own.
      if (!worker.window.webContents.isDestroyed())
        worker.window.webContents.forcefullyCrashRenderer()
      worker.window.destroy()
    }
  }
}
