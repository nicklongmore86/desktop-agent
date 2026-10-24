import {
  app,
  BrowserWindow,
  MessageChannelMain,
  session,
  utilityProcess,
  type UtilityProcess,
} from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { secureWebPreferences } from '../security'
import { checkDocumentSize, DEFAULT_LIMITS, effectiveBudget, type DocumentLimits } from './limits'
import { WORKER_PORT_CHANNEL, type FromBroker, type ToBroker } from './protocol'
import { checkReply } from './reply'
import type { SystemImageDecoder } from './system-heif'
import {
  DocumentError,
  type DocumentErrorCode,
  type DocumentView,
  type ExtractOptions,
} from './types'

/**
 * Runs document parsing in a hidden, sandboxed BrowserWindow: no Node, an in-memory
 * session of its own whose every request except the worker's own bundled files is
 * cancelled, and a CSP that allows only its own script and WASM.
 *
 * Main never holds a port the worker can post to. The worker's MessagePort leads to a
 * broker utility process (broker.ts), which deserialises and checks what the worker
 * sends and forwards a bounded copy; main checks that copy again. A hostile worker can
 * hang or crash only the broker, and main, still running, kills both. Bytes go in as
 * copies, never paths. Each job has a wall-clock timeout and a memory ceiling (worker
 * and broker together), after which both are killed; workers are recycled after a
 * number of jobs and shut down when idle. A new worker starts in roughly 150 ms.
 */

export interface DocumentWorkerOptions {
  /** The built worker page: out/document-worker. */
  workerDir: string
  /** Its preload: out/preload/document-worker.js. */
  preloadPath: string
  /** The broker utility process: out/main/document-broker.js. */
  brokerPath: string
  limits?: DocumentLimits
  timeoutMs?: number
  /** Working set above which a running job is killed; above 3/4 of it the worker is recycled. */
  memoryLimitBytes?: number
  maxJobsPerWorker?: number
  idleMs?: number
  partition?: string
  /**
   * Decodes HEIC photos, which Chromium cannot, with the system's codec (heif-decode.exe
   * on Windows). Without it they are refused with `unsupported`.
   */
  systemDecoder?: SystemImageDecoder
}

/** Where the worker's files are in a build: beside out/main, inside app.asar when packaged. */
export function documentWorkerPaths(mainDir: string): {
  workerDir: string
  preloadPath: string
  brokerPath: string
} {
  return {
    workerDir: join(mainDir, '../document-worker'),
    preloadPath: join(mainDir, '../preload/document-worker.js'),
    brokerPath: join(mainDir, 'document-broker.js'),
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

interface Job {
  id: number
  options: ExtractOptions
  resolve: (view: DocumentView) => void
  reject: (error: DocumentError) => void
}

interface Worker {
  window: BrowserWindow
  broker: UtilityProcess
  jobs: number
  pending: Job | null
  dead: boolean
  /** Waits for the broker's next startup message ('connected', then 'ready'). */
  starting: ((message: FromBroker | Error) => void) | null
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
  /** System decodes run one at a time too, beside the worker's jobs. */
  private decodes: Promise<unknown> = Promise.resolve()
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
    // Only the host asks for that.
    const { systemDecoded: _ignored, ...asked } = options
    return this.enqueue(copy, asked).then((view) =>
      view.systemDecode ? this.decodeWithSystem(copy, view, asked) : view,
    )
  }

  private enqueue(bytes: Uint8Array, options: ExtractOptions): Promise<DocumentView> {
    const run = this.queue.then(() => this.run(bytes, options))
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * A HEIC photo: the worker read its header and metadata but has no HEVC decoder. The
   * system codec decodes the original bytes (never anything the worker sent) into a PNG
   * in its own locked-down process, and a second worker job turns that upright, scales it
   * and re-encodes it, checked like any other image. Main never parses the photo or the PNG.
   */
  private async decodeWithSystem(
    bytes: Uint8Array,
    view: DocumentView,
    options: ExtractOptions,
  ): Promise<DocumentView> {
    const request = view.systemDecode
    delete view.systemDecode
    if (!request) return view
    const decoder = this.options.systemDecoder
    if (!decoder) {
      throw new DocumentError('unsupported', 'HEIC photos cannot be decoded in this session.')
    }
    const budget = effectiveBudget(options.budget, this.limits)
    const decoding = this.decodes.then(() =>
      decoder.decode(bytes, {
        longEdge: budget.longEdge,
        maxPixels: this.limits.maxDecodedPixels,
        maxInputBytes: this.limits.maxDocumentBytes,
        memoryBytes: this.memoryLimitBytes,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.limits.maxDocumentBytes,
      }),
    )
    this.decodes = decoding.catch(() => undefined)
    const png = await decoding
    const decoded = await this.enqueue(png, {
      mime: 'image/png',
      view: 'images',
      budget: { maxImages: 1, longEdge: budget.longEdge },
      systemDecoded: { cropped: request.cropped, orientation: request.orientation },
    })
    const [image] = decoded.images
    if (decoded.meta.kind !== 'png' || decoded.images.length !== 1 || !image) {
      throw new DocumentError('worker-failed', 'The decoded photo could not be read back.')
    }
    view.images = [image]
    return view
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
    const broker = utilityProcess.fork(this.options.brokerPath, [], {
      serviceName: 'Document reader broker',
      stdio: 'ignore',
    })
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

    const worker: Worker = { window, broker, jobs: 0, pending: null, dead: false, starting: null }
    contents.on('render-process-gone', () => {
      this.abort(worker, 'worker-failed', 'The document reader stopped unexpectedly.')
    })
    window.on('closed', () => {
      this.abort(worker, 'worker-failed', 'The document reader stopped unexpectedly.')
    })
    broker.on('message', (message: FromBroker) => {
      this.fromBroker(worker, message)
    })
    broker.on('exit', () => {
      this.abort(worker, 'worker-failed', 'The document reader stopped unexpectedly.')
    })

    const next = (): Promise<FromBroker> =>
      new Promise((resolveNext, rejectNext) => {
        const timer = setTimeout(() => {
          rejectNext(new Error('The document worker did not start'))
        }, START_TIMEOUT_MS)
        worker.starting = (message) => {
          clearTimeout(timer)
          worker.starting = null
          if (message instanceof Error) rejectNext(message)
          else resolveNext(message)
        }
      })
    try {
      // Both ends of the channel are handed over: one to the broker, one to the page.
      const { port1, port2 } = new MessageChannelMain()
      const connected = next()
      this.send(worker, { type: 'connect' }, [port1])
      const [answer] = await Promise.all([connected, window.loadURL(page)])
      if (answer.type !== 'connected') throw new Error('The document broker did not start')
      const ready = next()
      contents.postMessage(WORKER_PORT_CHANNEL, null, [port2])
      this.send(worker, { type: 'init', wasm })
      const status = await ready
      if (status.type === 'init-failed') {
        throw new Error(`The document worker failed to start: ${status.message}`)
      }
      if (status.type !== 'ready') throw new Error('The document worker did not start')
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

  private send(worker: Worker, message: ToBroker, ports: Electron.MessagePortMain[] = []): void {
    if (!worker.dead) worker.broker.postMessage(message, ports)
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
        options,
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

  /** Fails the running job, if any, and kills the worker and its broker. */
  private abort(worker: Worker, code: DocumentErrorCode, message: string): void {
    const job = worker.pending
    worker.pending = null
    this.kill(worker)
    worker.starting?.(new Error(message))
    job?.reject(new DocumentError(code, message))
  }

  private fromBroker(worker: Worker, message: FromBroker): void {
    if (worker.dead) return
    if (worker.starting) {
      worker.starting(message)
      return
    }
    if (message.type === 'violation') {
      this.abort(worker, 'worker-failed', message.message.slice(0, 500))
      return
    }
    const job = worker.pending
    if (!job) {
      this.abort(worker, 'worker-failed', 'The document reader sent a message nobody asked for.')
      return
    }
    // The broker already checked this; check its copy again before anyone uses it.
    let reply
    try {
      reply = checkReply(message, { id: job.id, options: job.options, limits: this.limits })
    } catch (error) {
      this.abort(
        worker,
        'worker-failed',
        error instanceof DocumentError ? error.message : 'The document reader failed.',
      )
      return
    }
    worker.pending = null
    if (reply.type === 'result') job.resolve(reply.view)
    else job.reject(new DocumentError(reply.code, reply.message))
  }

  /** Bytes in the worker renderer's and the broker's working sets together. */
  private memoryOf(worker: Worker): number {
    if (worker.dead || worker.window.isDestroyed()) return 0
    const pids = new Set([worker.window.webContents.getOSProcessId(), worker.broker.pid])
    let kilobytes = 0
    for (const metric of app.getAppMetrics()) {
      if (pids.has(metric.pid)) kilobytes += metric.memory.workingSetSize
    }
    return kilobytes * 1024
  }

  private kill(worker: Worker): void {
    if (worker.dead) return
    worker.dead = true
    worker.broker.kill()
    if (!worker.window.isDestroyed()) {
      // Crash first: a renderer stuck in a WASM loop won't unload on its own.
      if (!worker.window.webContents.isDestroyed())
        worker.window.webContents.forcefullyCrashRenderer()
      worker.window.destroy()
    }
  }
}
