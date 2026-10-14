import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const webContents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
  }
  const BrowserWindow = vi.fn(function (this: Record<string, unknown>, _options: unknown) {
    this['webContents'] = webContents
    this['once'] = vi.fn()
    this['show'] = vi.fn()
    this['loadURL'] = vi.fn(() => Promise.resolve())
  })
  return {
    app: { isPackaged: false },
    BrowserWindow,
    webContents,
    shell: { openExternal: vi.fn() },
  }
})

vi.mock('electron', () => electron)

const { appUrl, createMainWindow } = await import('./window')

type OpenHandler = (details: { url: string }) => { action: string }
type NavigationHandler = (event: { preventDefault: () => void }, url: string) => void

function navigationHandler(eventName: string): NavigationHandler {
  const call = electron.webContents.on.mock.calls.find(([name]) => name === eventName)
  if (!call) throw new Error(`no ${eventName} handler registered`)
  return call[1] as NavigationHandler
}

describe('appUrl', () => {
  beforeEach(() => {
    electron.app.isPackaged = false
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses a loopback dev server URL in unpackaged builds', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
    expect(appUrl()).toBe('http://127.0.0.1:5173')
  })

  it('ignores ELECTRON_RENDERER_URL in packaged builds', () => {
    electron.app.isPackaged = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    expect(appUrl()).toMatch(/^file:\/\/.*\/renderer\/index\.html$/)
  })

  it.each(['https://localhost:5173', 'http://example.com:5173', 'https://example.com/'])(
    'rejects the non-loopback or https dev URL %s',
    (devUrl) => {
      vi.stubEnv('ELECTRON_RENDERER_URL', devUrl)
      expect(appUrl()).toMatch(/^file:\/\/.*\/renderer\/index\.html$/)
    },
  )
})

describe('createMainWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electron.app.isPackaged = false
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('loads the bundled file, not the env URL, when packaged', () => {
    electron.app.isPackaged = true
    const window = createMainWindow() as unknown as { loadURL: ReturnType<typeof vi.fn> }
    expect(window.loadURL).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/.*\/renderer\/index\.html$/),
    )
  })

  it('creates the BrowserWindow with secure webPreferences', () => {
    createMainWindow()

    expect(electron.BrowserWindow).toHaveBeenCalledTimes(1)
    const options = electron.BrowserWindow.mock.calls[0]?.[0] as {
      webPreferences: Record<string, unknown>
    }
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    })
    expect(options.webPreferences['preload']).toMatch(/preload[\\/]index\.js$/)
  })

  it('denies every window.open and opens web links externally', () => {
    createMainWindow()
    const handler = electron.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as OpenHandler

    expect(handler({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/')

    expect(handler({ url: 'file:///C:/Windows/System32/calc.exe' })).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1)
  })

  it.each(['will-navigate', 'will-redirect'])('blocks %s away from the app', (eventName) => {
    createMainWindow()
    const handler = navigationHandler(eventName)

    const external = { preventDefault: vi.fn() }
    handler(external, 'https://example.com/')
    expect(external.preventDefault).toHaveBeenCalled()

    const internal = { preventDefault: vi.fn() }
    handler(internal, 'http://localhost:5173/#chat')
    expect(internal.preventDefault).not.toHaveBeenCalled()
  })
})
