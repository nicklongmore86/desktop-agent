import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LIMITS } from './limits'
import type { FromWorker, ToWorker } from './protocol'
import type { DocumentView } from './types'

/** Electron stand-ins: a "worker" that answers over a fake MessagePort however a test says. */
const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const state = {
    windows: [] as FakeWindow[],
    respond: (_message: unknown, _reply: (data: unknown) => void): void => undefined,
    memoryKb: 100_000,
    beforeRequest: null as
      null | ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
  }
  class FakePort {
    listeners: Listener[] = []
    closed = false
    on(_event: string, listener: Listener) {
      this.listeners.push(listener)
    }
    start() {}
    close() {
      this.closed = true
    }
    postMessage(message: unknown) {
      if (this.closed) return
      queueMicrotask(() => {
        state.respond(message, (data) => {
          if (!this.closed) for (const listener of this.listeners) listener({ data })
        })
      })
    }
  }
  class FakeWindow {
    destroyed = false
    crashed = false
    handlers = new Map<string, Listener[]>()
    contentsHandlers = new Map<string, Listener[]>()
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      state.windows.push(this)
    }
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: (event: string, listener: Listener) => {
        this.contentsHandlers.set(event, [...(this.contentsHandlers.get(event) ?? []), listener])
      },
      postMessage: vi.fn(),
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
    FakeWindow,
    module: {
      app: {
        isPackaged: false,
        getAppMetrics: () => [{ pid: 4242, memory: { workingSetSize: state.memoryKb } }],
      },
      BrowserWindow: FakeWindow,
      MessageChannelMain: class {
        port1 = new FakePort()
        port2 = new FakePort()
      },
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

let workerDir: string
beforeEach(() => {
  workerDir = mkdtempSync(join(tmpdir(), 'doc-worker-'))
  mkdirSync(join(workerDir, 'assets'))
  writeFileSync(join(workerDir, 'assets', 'pdfium.wasm'), 'wasm')
  electron.state.windows.length = 0
  electron.state.memoryKb = 100_000
  // A healthy worker: ready on init, answers each job with a small text view.
  electron.state.respond = (message, reply) => {
    const m = message as ToWorker
    if (m.type === 'init') reply({ type: 'ready' } satisfies FromWorker)
    else reply({ type: 'result', id: m.id, view: view() } satisfies FromWorker)
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})

const host = (options = {}) =>
  new DocumentWorkerHost({ workerDir, preloadPath: '/x/preload.js', ...options })
const bytes = new TextEncoder().encode('hello')

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

  it('sends a private copy of the bytes, never a shared pool', async () => {
    const sent: Uint8Array[] = []
    const respond = electron.state.respond
    electron.state.respond = (message, reply) => {
      const m = message as ToWorker
      if (m.type === 'extract') sent.push(m.bytes)
      respond(message, reply)
    }
    const pooled = Buffer.from('hello')
    await host().extract(pooled)
    expect(sent[0]?.buffer.byteLength).toBe(5)
  })

  it('times out, destroys the window, and starts fresh for the next job', async () => {
    let hang = true
    electron.state.respond = (message, reply) => {
      const m = message as ToWorker
      if (m.type === 'init') reply({ type: 'ready' })
      else if (!hang) reply({ type: 'result', id: m.id, view: view() })
    }
    const h = host({ timeoutMs: 50 })
    await expect(h.extract(bytes)).rejects.toMatchObject({ code: 'timeout' })
    expect(electron.state.windows[0]).toMatchObject({ destroyed: true, crashed: true })
    hang = false
    await expect(h.extract(bytes)).resolves.toBeDefined()
    expect(h.stats().workersStarted).toBe(2)
  })

  it('kills a job that goes over the memory limit', async () => {
    electron.state.respond = (message, reply) => {
      if ((message as ToWorker).type === 'init') reply({ type: 'ready' })
    }
    electron.state.memoryKb = 4 * 1024 * 1024
    const h = host({ memoryLimitBytes: 1024 * 1024 * 1024 })
    await expect(h.extract(bytes)).rejects.toMatchObject({ code: 'memory' })
    expect(electron.state.windows[0]?.destroyed).toBe(true)
  })

  it('recycles the worker after N jobs', async () => {
    const h = host({ maxJobsPerWorker: 2 })
    for (let i = 0; i < 5; i++) await h.extract(bytes)
    expect(h.stats()).toMatchObject({ workersStarted: 3, jobs: 5 })
    expect(electron.state.windows.filter((w) => w.destroyed)).toHaveLength(2)
    await h.dispose()
  })

  it('validates what the worker sends back', async () => {
    let reply: unknown = view({
      images: [
        { bytes: new Uint8Array(1), mime: 'text/html' as never, width: 1, height: 1, source: {} },
      ],
    })
    electron.state.respond = (message, send) => {
      const m = message as ToWorker
      if (m.type === 'init') send({ type: 'ready' })
      else send({ type: 'result', id: m.id, view: reply })
    }
    const h = host()
    await expect(h.extract(bytes)).rejects.toMatchObject({ code: 'worker-failed' })
    reply = { nonsense: true }
    await expect(h.extract(bytes)).rejects.toMatchObject({ code: 'worker-failed' })
  })

  it('passes known refusals through and masks anything else', async () => {
    let code = 'password-protected'
    electron.state.respond = (message, send) => {
      const m = message as ToWorker
      if (m.type === 'init') send({ type: 'ready' })
      else send({ type: 'error', id: m.id, code, message: 'locked' })
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
    electron.state.respond = (message, reply) => {
      if ((message as ToWorker).type === 'init') reply({ type: 'init-failed', message: 'no wasm' })
    }
    await expect(host().extract(bytes)).rejects.toMatchObject({ code: 'worker-failed' })
    expect(electron.state.windows[0]?.destroyed).toBe(true)
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
