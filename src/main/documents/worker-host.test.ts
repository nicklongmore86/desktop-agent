import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext, makeSandbox, put, type Sandbox } from '../permissions/test-support'
import { toolHarness } from '../tools/test-support'
import { makePdf, pngShell } from './fixtures.test-util'
import { DEFAULT_LIMITS } from './limits'
import type { ExtractJob, FromBroker, ToBroker } from './protocol'
import { DocumentError, type DocumentView } from './types'

/**
 * Electron stand-ins. The fake broker answers main's messages however a test says;
 * the worker renderer behind it is not modelled (the e2e tests run the real one).
 */
const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const state = {
    windows: [] as FakeWindow[],
    brokers: [] as FakeBroker[],
    ports: [] as FakePort[],
    /** How the broker answers each extract job; `reply` sends a message to main. */
    answer: (_job: unknown, _reply: (message: unknown) => void, _broker: FakeBroker): void =>
      undefined,
    startup: 'ok' as 'ok' | 'init-failed' | 'silent',
    memoryKb: 100_000,
    beforeRequest: null as
      null | ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
  }
  class FakePort {
    listeners: string[] = []
    constructor() {
      state.ports.push(this)
    }
    on(event: string) {
      this.listeners.push(event)
    }
    start() {}
    close() {}
    postMessage() {}
  }
  class FakeBroker {
    pid = 9000 + state.brokers.length
    killed = false
    received: { message: unknown; ports: unknown[] }[] = []
    private handlers = new Map<string, Listener[]>()
    constructor(readonly modulePath: string) {
      state.brokers.push(this)
    }
    on(event: string, listener: Listener) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    }
    emit(event: string, ...args: unknown[]) {
      for (const listener of this.handlers.get(event) ?? []) listener(...args)
    }
    reply = (message: unknown) => {
      queueMicrotask(() => {
        if (!this.killed) this.emit('message', message)
      })
    }
    postMessage(message: unknown, ports: unknown[] = []) {
      this.received.push({ message, ports })
      const m = message as ToBroker
      if (m.type === 'connect') this.reply({ type: 'connected' })
      else if (m.type === 'init') {
        if (state.startup === 'ok') this.reply({ type: 'ready' })
        else if (state.startup === 'init-failed') this.reply({ type: 'init-failed', message: 'x' })
      } else state.answer(m, this.reply, this)
    }
    kill() {
      if (this.killed) return false
      this.killed = true
      return true
    }
  }
  class FakeWindow {
    destroyed = false
    crashed = false
    handlers = new Map<string, Listener[]>()
    posted: { channel: string; ports: unknown[] }[] = []
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      state.windows.push(this)
    }
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      postMessage: (channel: string, _message: unknown, ports: unknown[]) => {
        this.posted.push({ channel, ports })
      },
      getOSProcessId: () => 4242,
      isDestroyed: () => this.destroyed,
      forcefullyCrashRenderer: () => {
        this.crashed = true
      },
    }
    loadURL = vi.fn(() => Promise.resolve())
    on(event: string, listener: Listener) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      for (const listener of this.handlers.get('closed') ?? []) listener()
    }
  }
  return {
    state,
    module: {
      app: {
        isPackaged: false,
        getAppMetrics: () => [
          { pid: 4242, memory: { workingSetSize: state.memoryKb } },
          ...state.brokers.map((b) => ({ pid: b.pid, memory: { workingSetSize: 50_000 } })),
        ],
      },
      BrowserWindow: FakeWindow,
      MessageChannelMain: class {
        port1 = new FakePort()
        port2 = new FakePort()
      },
      utilityProcess: { fork: (modulePath: string) => new FakeBroker(modulePath) },
      session: {
        fromPartition: () => ({
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          on: vi.fn(),
          webRequest: {
            onBeforeRequest: (listener: typeof state.beforeRequest) => {
              state.beforeRequest = listener
            },
          },
        }),
      },
    },
  }
})

vi.mock('electron', () => electron.module)

const { DocumentWorkerHost, isWorkerRequestAllowed } = await import('./worker-host')

const view = (overrides: Partial<DocumentView> = {}): DocumentView => ({
  meta: { kind: 'text', mime: 'text/plain' },
  sections: [{ text: 'hi' }],
  images: [],
  position: { unit: 'char', total: 2, shown: { from: 1, to: 2 }, next: null },
  warnings: [],
  ...overrides,
})
const result = (job: unknown, overrides: Partial<DocumentView> = {}): FromBroker => ({
  type: 'result',
  id: (job as ExtractJob).id,
  view: view(overrides),
})

let workerDir: string
beforeEach(() => {
  workerDir = mkdtempSync(join(tmpdir(), 'doc-worker-'))
  mkdirSync(join(workerDir, 'assets'))
  writeFileSync(join(workerDir, 'assets', 'pdfium.wasm'), 'wasm')
  electron.state.windows.length = 0
  electron.state.brokers.length = 0
  electron.state.ports.length = 0
  electron.state.memoryKb = 100_000
  electron.state.startup = 'ok'
  electron.state.answer = (job, reply) => {
    reply(result(job))
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})

const host = (options = {}) =>
  new DocumentWorkerHost({
    workerDir,
    preloadPath: '/x/preload.js',
    brokerPath: '/x/broker.js',
    ...options,
  })
const bytes = new TextEncoder().encode('hello')
const killed = (index: number) => ({
  window: electron.state.windows[index]?.destroyed,
  broker: electron.state.brokers[index]?.killed,
})

describe('DocumentWorkerHost', () => {
  it('parses in a hidden, sandboxed window on its own session', async () => {
    const h = host()
    await expect(h.extract(bytes)).resolves.toMatchObject({ sections: [{ text: 'hi' }] })
    const [window] = electron.state.windows
    expect(window?.options).toMatchObject({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'document-worker',
        preload: '/x/preload.js',
      },
    })
    expect(window?.loadURL).toHaveBeenCalledWith(pathToFileURL(join(workerDir, 'index.html')).href)
    expect(electron.state.brokers[0]?.modulePath).toBe('/x/broker.js')
    // The request filter lets the worker's own files through and nothing else.
    const decide = (url: string) =>
      new Promise<boolean>((resolve) => {
        electron.state.beforeRequest?.({ url }, ({ cancel }) => {
          resolve(cancel)
        })
      })
    expect(await decide(pathToFileURL(join(workerDir, 'assets/index.js')).href)).toBe(false)
    expect(await decide('https://example.com/')).toBe(true)
    expect(await decide(pathToFileURL(join(workerDir, '../secret.txt')).href)).toBe(true)
    await h.dispose()
  })

  it('never holds a port the worker can post to: one end to the broker, one to the page', async () => {
    await host().extract(bytes)
    const [port1, port2] = electron.state.ports
    const [broker] = electron.state.brokers
    const [window] = electron.state.windows
    expect(broker?.received[0]).toEqual({ message: { type: 'connect' }, ports: [port1] })
    expect(window?.posted).toEqual([{ channel: 'document-worker:port', ports: [port2] }])
    // Main listens on neither end.
    expect(port1?.listeners).toEqual([])
    expect(port2?.listeners).toEqual([])
  })

  it('sends a private copy of the bytes, never a shared pool', async () => {
    const sent: Uint8Array[] = []
    electron.state.answer = (job, reply) => {
      sent.push((job as ExtractJob).bytes)
      reply(result(job))
    }
    const pooled = Buffer.from('hello')
    await host().extract(pooled)
    expect(sent[0]?.buffer.byteLength).toBe(5)
  })

  it('times out, kills the worker and its broker, and starts fresh for the next job', async () => {
    let hang = true
    electron.state.answer = (job, reply) => {
      if (!hang) reply(result(job))
    }
    const h = host({ timeoutMs: 50 })
    await expect(h.extract(bytes)).rejects.toMatchObject({ code: 'timeout' })
    expect(electron.state.windows[0]).toMatchObject({ destroyed: true, crashed: true })
    expect(electron.state.brokers[0]?.killed).toBe(true)
    hang = false
    await expect(h.extract(bytes)).resolves.toBeDefined()
    expect(h.stats().workersStarted).toBe(2)
  })

  it('fails the job at once when the broker dies (a hostile message crashed it)', async () => {
    let crash = true
    electron.state.answer = (job, reply, broker) => {
      if (crash) {
        queueMicrotask(() => {
          broker.emit('exit', 1)
        })
      } else reply(result(job))
    }
    const h = host({ timeoutMs: 60_000 })
    const started = Date.now()
    await expect(h.extract(bytes)).rejects.toMatchObject({ code: 'worker-failed' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(killed(0)).toEqual({ window: true, broker: true })
    crash = false
    await expect(h.extract(bytes)).resolves.toBeDefined()
  })

  it('fails the job and kills both when the broker reports a violation', async () => {
    let bad = true
    electron.state.answer = (job, reply) => {
      reply(
        bad ? { type: 'violation', message: 'it returned more images than asked' } : result(job),
      )
    }
    const h = host()
    await expect(h.extract(bytes)).rejects.toMatchObject({
      code: 'worker-failed',
      message: 'it returned more images than asked',
    })
    expect(killed(0)).toEqual({ window: true, broker: true })
    bad = false
    await expect(h.extract(bytes)).resolves.toBeDefined()
  })

  it('checks the broker’s copy again and kills on anything off', async () => {
    electron.state.answer = (job, reply) => {
      reply(result(job, { images: new Array(21).fill(null) as never }))
    }
    await expect(host().extract(bytes)).rejects.toMatchObject({ code: 'worker-failed' })
    expect(killed(0)).toEqual({ window: true, broker: true })
  })

  it('checks the broker’s copy of a sheet’s claimed cells against the per-call cap', async () => {
    const sheet = (shown: string): Partial<DocumentView> => ({
      meta: { kind: 'xlsx', mime: 'x', sheets: [{ name: 'S', used: 'A1:XFD1048576' }] },
      sections: [{ text: 'x', sheet: { name: 'S', shown, used: 'A1:XFD1048576' } }],
      images: [],
      position: { unit: 'sheet', total: 1, shown: { from: 1, to: 1 }, next: null },
    })
    let shown = 'A1:XFD1048576'
    electron.state.answer = (job, reply) => {
      reply(result(job, sheet(shown)))
    }
    const h = host()
    await expect(h.extract(bytes)).rejects.toMatchObject({
      code: 'worker-failed',
      message: expect.stringContaining('it returned more cells than allowed') as unknown,
    })
    expect(killed(0)).toEqual({ window: true, broker: true })
    shown = 'A1:J1000'
    await expect(h.extract(bytes)).resolves.toMatchObject({ sections: [{ text: 'x' }] })
  })

  it('accepts 20 images near the byte limit, keeps the worker, and leaves nothing running', async () => {
    const big = new Uint8Array(DEFAULT_LIMITS.maxImageBytes - 1024)
    big.set(pngShell(1000, 1000))
    const images = Array.from({ length: 20 }, () => ({
      bytes: big,
      mime: 'image/png' as const,
      width: 1000,
      height: 1000,
      source: { page: 1 },
    }))
    electron.state.answer = (job, reply) => {
      reply(
        result(job, {
          meta: { kind: 'pdf', mime: 'application/pdf', pageCount: 1 },
          sections: [{ page: 1, text: 'x' }],
          images,
          position: { unit: 'page', total: 1, shown: { from: 1, to: 1 }, next: null },
        }),
      )
    }
    const h = host()
    for (let i = 0; i < 2; i++) {
      const view = await h.extract(bytes)
      expect(view.images).toHaveLength(20)
      expect(view.images[0]?.bytes.length).toBe(big.length)
    }
    expect(h.stats()).toMatchObject({ workersStarted: 1, jobs: 2 })
    expect(killed(0)).toEqual({ window: false, broker: false })
    await h.dispose()
    expect(electron.state.windows.every((w) => w.destroyed)).toBe(true)
    expect(electron.state.brokers.every((b) => b.killed)).toBe(true)
  })

  it('kills a reply for another job id', async () => {
    electron.state.answer = (job, reply) => {
      reply({ ...result(job), id: (job as ExtractJob).id + 1 })
    }
    await expect(host().extract(bytes)).rejects.toMatchObject({ code: 'worker-failed' })
    expect(killed(0)).toEqual({ window: true, broker: true })
  })

  it('kills a job that goes over the memory limit (worker and broker together)', async () => {
    electron.state.answer = () => undefined
    // 1000 MB renderer + 50 MB broker > 1 GB.
    electron.state.memoryKb = 1000 * 1024
    const h = host({ memoryLimitBytes: 1024 * 1024 * 1024 })
    await expect(h.extract(bytes)).rejects.toMatchObject({ code: 'memory' })
    expect(killed(0)).toEqual({ window: true, broker: true })
  })

  it('recycles the worker after N jobs', async () => {
    const h = host({ maxJobsPerWorker: 2 })
    for (let i = 0; i < 5; i++) await h.extract(bytes)
    expect(h.stats()).toMatchObject({ workersStarted: 3, jobs: 5 })
    expect(electron.state.windows.filter((w) => w.destroyed)).toHaveLength(2)
    expect(electron.state.brokers.filter((b) => b.killed)).toHaveLength(2)
    await h.dispose()
  })

  it('passes known refusals through and masks anything else', async () => {
    let code = 'password-protected'
    electron.state.answer = (job, reply) => {
      reply({ type: 'error', id: (job as ExtractJob).id, code, message: 'locked' })
    }
    const h = host()
    await expect(h.extract(bytes)).rejects.toMatchObject({
      code: 'password-protected',
      message: 'locked',
    })
    code = 'timeout'
    await expect(h.extract(bytes)).rejects.toMatchObject({ code: 'worker-failed' })
  })

  it('refuses oversized input before starting a worker', () => {
    const h = host({ limits: { ...DEFAULT_LIMITS, maxDocumentBytes: 3 } })
    expect(() => h.extract(bytes)).toThrow(expect.objectContaining({ code: 'too-large' }))
    expect(electron.state.windows).toHaveLength(0)
  })

  it('fails cleanly when the worker cannot start', async () => {
    electron.state.startup = 'init-failed'
    await expect(host().extract(bytes)).rejects.toMatchObject({ code: 'worker-failed' })
    expect(killed(0)).toEqual({ window: true, broker: true })
  })

  it('fails cleanly when the broker dies while starting', async () => {
    electron.state.startup = 'silent'
    const h = host()
    const job = h.extract(bytes)
    await vi.waitFor(() => {
      expect(electron.state.brokers[0]?.received.length).toBe(2)
    })
    electron.state.brokers[0]?.emit('exit', 1)
    await expect(job).rejects.toMatchObject({ code: 'worker-failed' })
    expect(killed(0)).toEqual({ window: true, broker: true })
  })
})

describe('the reader queue', () => {
  /** Holds every job until a test answers it; `sent` lists the jobs in the order they ran. */
  function held() {
    const sent: ExtractJob[] = []
    const replies: ((message: unknown) => void)[] = []
    electron.state.answer = (job, reply) => {
      sent.push(job as ExtractJob)
      replies.push(reply)
    }
    const answer = async (index: number) => {
      await vi.waitFor(() => {
        expect(sent.length).toBeGreaterThan(index)
      })
      replies[index]?.(result(sent[index]))
    }
    return { sent, answer }
  }
  const named = (name: string) => ({ name })

  it('runs read_document and attachment jobs before waiting search jobs', async () => {
    const { sent, answer } = held()
    const h = host()
    const first = h.extract(bytes, named('first'))
    const search = h.extract(bytes, named('search'), { background: true })
    const read = h.extract(bytes, named('read'))
    await answer(0)
    await answer(1)
    await answer(2)
    await Promise.all([first, search, read])
    expect(sent.map((job) => job.options.name)).toEqual(['first', 'read', 'search'])
    await h.dispose()
  })

  it('keeps at most one search job in the reader, waiting or running', async () => {
    const { sent, answer } = held()
    const h = host()
    const running = h.extract(bytes, named('a'), { background: true })
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    await expect(h.extract(bytes, named('b'), { background: true })).rejects.toMatchObject({
      code: 'busy',
      message: 'The document reader is still busy with an earlier search.',
    })
    expect(h.stats()).toMatchObject({ queued: 0, queuedBytes: 0 })
    // read_document is not refused, and waits behind that one job only.
    const read = h.extract(bytes, named('read'))
    await answer(0)
    await running
    await answer(1)
    await read
    // Once it is done, the next search's job is taken.
    const next = h.extract(bytes, named('c'), { background: true })
    await answer(2)
    await next
    expect(sent.map((job) => job.options.name)).toEqual(['a', 'read', 'c'])
    await h.dispose()
  })

  it('takes a waiting job out of the queue, bytes and all, when its caller stops waiting', async () => {
    const { sent, answer } = held()
    const h = host()
    const read = h.extract(bytes, named('read'))
    const stop = new AbortController()
    const search = h.extract(bytes, named('search'), { background: true, signal: stop.signal })
    expect(h.stats()).toMatchObject({ queued: 1, queuedBytes: bytes.length })
    stop.abort()
    await expect(search).rejects.toMatchObject({ code: 'cancelled' })
    expect(h.stats()).toMatchObject({ queued: 0, queuedBytes: 0 })
    await answer(0)
    await read
    // It never reached the worker, and no longer counts as the search's one job.
    const next = h.extract(bytes, named('next'), { background: true })
    await answer(1)
    await next
    expect(sent.map((job) => job.options.name)).toEqual(['read', 'next'])
    // Already stopped: never queued at all.
    await expect(
      h.extract(bytes, named('late'), { background: true, signal: stop.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(h.stats().queued).toBe(0)
    await h.dispose()
  })

  it('lets a running job finish when its caller stops waiting', async () => {
    const { answer } = held()
    const h = host()
    const stop = new AbortController()
    const search = h.extract(bytes, named('search'), { background: true, signal: stop.signal })
    await vi.waitFor(() => {
      expect(h.stats().queued).toBe(0)
    })
    stop.abort()
    await answer(0)
    await expect(search).resolves.toMatchObject({ sections: [{ text: 'hi' }] })
    await h.dispose()
  })

  it('refuses jobs past the queue’s job and byte limits, for every caller', async () => {
    const { answer } = held()
    const h = host({ maxQueuedJobs: 2, maxQueuedBytes: 12 })
    const jobs = [h.extract(bytes), h.extract(bytes), h.extract(bytes)]
    expect(h.stats()).toMatchObject({ queued: 2, queuedBytes: 10 })
    const busy = {
      code: 'busy',
      message: 'The document reader is busy with other documents. Try again in a moment.',
    }
    await expect(h.extract(bytes)).rejects.toMatchObject(busy)
    await expect(h.extract(bytes, {}, { background: true })).rejects.toMatchObject(busy)
    expect(h.stats()).toMatchObject({ queued: 2, queuedBytes: 10 })
    await answer(0)
    await jobs[0]
    // One waits now (5 bytes): another 5 fit in 12, then 15 would not.
    expect(h.stats()).toMatchObject({ queued: 1, queuedBytes: 5 })
    jobs.push(h.extract(bytes))
    await expect(h.extract(bytes)).rejects.toMatchObject(busy)
    for (let i = 1; i < 4; i++) await answer(i)
    await Promise.all(jobs)
    // A job on its own is taken whatever its size (the document limit bounds it).
    const big = new Uint8Array(100)
    const alone = h.extract(big)
    await answer(4)
    await alone
    await h.dispose()
  })
})

describe('search_files over the reader', () => {
  let sb: Sandbox
  beforeEach(async () => {
    sb = await makeSandbox()
    for (const name of ['a', 'b', 'c']) {
      await put(join(sb.root, `${name}.pdf`), Buffer.from(makePdf([{ text: ['freezer'] }])))
    }
  })
  afterEach(async () => {
    await sb.cleanup()
  })

  it('never has more than one search job in the reader, however often it is searched', async () => {
    const sent: ExtractJob[] = []
    const replies: ((message: unknown) => void)[] = []
    // Every job hangs until answered: each search gives up on its reader call.
    electron.state.answer = (job, reply) => {
      sent.push(job as ExtractJob)
      replies.push(reply)
    }
    const h = host()
    const tools = toolHarness(sb, { documents: h, limits: { searchDocumentTimeMs: 30 } })
    const search = () =>
      tools
        .tool('search_files')
        .execute({ path: sb.root, contentPattern: 'freezer' }, fakeContext().ctx)
    const first = await search()
    expect(first.content).toContain(
      'Documents: 0 searched, 3 not searched yet (stopped at the 0.03 s time for reading documents).',
    )
    for (let i = 0; i < 5; i++) {
      const again = await search()
      expect(again.content).toContain(
        'Documents: 0 searched, 3 not searched yet (stopped at the document reader, still busy ' +
          'with an earlier search or other documents).',
      )
      expect(h.stats()).toMatchObject({ queued: 0, queuedBytes: 0 })
    }
    // Only the first search's one call ever reached the reader.
    expect(sent).toHaveLength(1)
    // read_document goes ahead of everything else and waits for that one job only.
    const read = h.extract(Buffer.from(makePdf([{ text: ['x'] }])), { name: 'read.pdf' })
    expect(h.stats().queued).toBe(1)
    replies[0]?.({ type: 'error', id: sent[0]?.id, code: 'malformed', message: 'x' })
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2)
    })
    expect(sent[1]?.options.name).toBe('read.pdf')
    replies[1]?.(result(sent[1]))
    await read
    await h.dispose()
  })

  it('takes a search job that never started out of the queue at the deadline', async () => {
    const sent: ExtractJob[] = []
    const replies: ((message: unknown) => void)[] = []
    electron.state.answer = (job, reply) => {
      sent.push(job as ExtractJob)
      replies.push(reply)
    }
    const h = host()
    // A read_document job is running, so the search's job can only wait.
    const read = h.extract(bytes, { name: 'read' })
    const tools = toolHarness(sb, { documents: h, limits: { searchDocumentTimeMs: 30 } })
    const r = await tools
      .tool('search_files')
      .execute({ path: sb.root, contentPattern: 'freezer' }, fakeContext().ctx)
    expect(r.content).toContain('3 not searched yet')
    expect(h.stats()).toMatchObject({ queued: 0, queuedBytes: 0 })
    replies[0]?.(result(sent[0]))
    await read
    // The search's job never ran, and the next search's job is taken.
    const next = h.extract(bytes, { name: 'next' }, { background: true })
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2)
    })
    expect(sent.map((job) => job.options.name)).toEqual(['read', 'next'])
    replies[1]?.(result(sent[1]))
    await next
    await h.dispose()
  })
})

describe('isWorkerRequestAllowed', () => {
  const dir = join(tmpdir(), 'app', 'out', 'document-worker')
  it.each([
    [pathToFileURL(join(dir, 'index.html')).href, true],
    [pathToFileURL(join(dir, 'assets', 'index.js')).href, true],
    [pathToFileURL(dir).href, false],
    [pathToFileURL(join(dir, '..', 'renderer', 'index.html')).href, false],
    [`${pathToFileURL(join(dir, 'index.html')).href}?x=1`, false],
    ['https://example.com/a.js', false],
    ['data:text/javascript,alert(1)', false],
    ['devtools://devtools/bundled/inspector.html', false],
    ['file://server/share/x.js', false],
    ['not a url', false],
  ])('%s -> %s', (url, allowed) => {
    expect(isWorkerRequestAllowed(url, dir)).toBe(allowed)
  })
})

describe('HEIC photos through the system decoder', () => {
  const photo = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3])
  const heicView = (overrides: Partial<DocumentView> = {}): Partial<DocumentView> => ({
    meta: { kind: 'heic', mime: 'image/heic', width: 32, height: 64 },
    sections: [{ title: 'Image metadata', text: 'Camera: Apple iPhone 15' }],
    position: { unit: 'image', total: 1, shown: { from: 1, to: 1 }, next: null },
    systemDecode: {
      format: 'heif',
      coded: { width: 64, height: 64 },
      cropped: { width: 64, height: 32 },
      orientation: 6,
    },
    ...overrides,
  })
  const upright = pngShell(32, 64)
  let jobs: ExtractJob[]
  beforeEach(() => {
    jobs = []
    electron.state.answer = (job, reply) => {
      const extract = job as ExtractJob
      jobs.push(extract)
      if (jobs.length === 1) reply(result(job, heicView()))
      else
        reply(
          result(job, {
            meta: { kind: 'png', mime: 'image/png', width: 32, height: 64 },
            sections: [],
            images: [{ bytes: upright, mime: 'image/png', width: 32, height: 64, source: {} }],
            position: { unit: 'image', total: 1, shown: { from: 1, to: 1 }, next: null },
          }),
        )
    }
  })
  const decoder = (decode: () => Promise<Uint8Array>) => ({
    support: vi.fn(() => Promise.resolve({ supported: true as const })),
    decode: vi.fn(decode),
  })

  it('decodes the original bytes with the system codec, then re-reads its PNG in the worker', async () => {
    const system = decoder(() => Promise.resolve(pngShell(64, 32)))
    const h = host({ systemDecoder: system })
    const read = await h.extract(photo, { name: 'IMG.HEIC', budget: { longEdge: 800 } })
    expect(system.decode).toHaveBeenCalledWith(photo, {
      longEdge: 800,
      maxPixels: 100_000_000,
      maxInputBytes: DEFAULT_LIMITS.maxDocumentBytes,
      memoryBytes: 1536 * 1024 * 1024,
      timeoutMs: 30_000,
      maxOutputBytes: DEFAULT_LIMITS.maxDocumentBytes,
    })
    // The second job is the PNG, with what the worker read from the original.
    expect(jobs).toHaveLength(2)
    expect(jobs[1]?.bytes).toEqual(pngShell(64, 32))
    expect(jobs[1]?.options).toEqual({
      mime: 'image/png',
      view: 'images',
      budget: { maxImages: 1, longEdge: 800 },
      systemDecoded: { cropped: { width: 64, height: 32 }, orientation: 6 },
    })
    expect(read.meta).toMatchObject({ kind: 'heic', width: 32, height: 64 })
    expect(read.sections[0]?.text).toBe('Camera: Apple iPhone 15')
    expect(read.images).toEqual([
      { bytes: upright, mime: 'image/png', width: 32, height: 64, source: {} },
    ])
    expect(read.systemDecode).toBeUndefined()
  })

  it('refuses with the decoder’s reason when the codec is missing, without a second job', async () => {
    const system = decoder(() =>
      Promise.reject(new DocumentError('unsupported', 'Install HEIF Image Extensions.')),
    )
    await expect(host({ systemDecoder: system }).extract(photo)).rejects.toMatchObject({
      code: 'unsupported',
      message: 'Install HEIF Image Extensions.',
    })
    expect(jobs).toHaveLength(1)
  })

  it('refuses HEIC when there is no system decoder at all', async () => {
    await expect(host().extract(photo)).rejects.toMatchObject({ code: 'unsupported' })
    expect(jobs).toHaveLength(1)
  })

  it('never lets a caller pass what only the host may', async () => {
    const system = decoder(() => Promise.resolve(pngShell(64, 32)))
    await host({ systemDecoder: system }).extract(photo, {
      systemDecoded: { cropped: { width: 1, height: 1 }, orientation: 3 },
    })
    expect(jobs[0]?.options).toEqual({})
  })

  it('fails when the second job does not give back one PNG', async () => {
    electron.state.answer = (job, reply) => {
      jobs.push(job as ExtractJob)
      reply(
        result(job, jobs.length === 1 ? heicView() : { meta: { kind: 'png', mime: 'image/png' } }),
      )
    }
    const system = decoder(() => Promise.resolve(pngShell(64, 32)))
    await expect(host({ systemDecoder: system }).extract(photo)).rejects.toMatchObject({
      code: 'worker-failed',
    })
  })

  it('kills a worker that asks for a decode the photo does not need', async () => {
    electron.state.answer = (job, reply) => {
      reply(result(job, { ...heicView(), meta: { kind: 'jpeg', mime: 'image/jpeg' } }))
    }
    const system = decoder(() => Promise.resolve(pngShell(64, 32)))
    await expect(host({ systemDecoder: system }).extract(photo)).rejects.toMatchObject({
      code: 'worker-failed',
    })
    expect(system.decode).not.toHaveBeenCalled()
    expect(killed(0)).toEqual({ window: true, broker: true })
  })
})
