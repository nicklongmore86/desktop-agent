import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels, type ApprovalPrompt, type ChatEvent } from '../shared/ipc'

const electron = vi.hoisted(() => {
  class FakeNotification {
    static supported = true
    static shown: FakeNotification[] = []
    static isSupported = () => FakeNotification.supported
    handlers = new Map<string, () => void>()
    constructor(public options: { title: string; body: string; icon?: string }) {}
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler)
    }
    show() {
      FakeNotification.shown.push(this)
    }
  }
  return {
    FakeNotification,
    app: { prependListener: vi.fn(), quit: vi.fn() },
    dialog: { showMessageBox: vi.fn() },
    powerMonitor: { on: vi.fn() },
    screen: {
      getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]),
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })),
    },
  }
})

vi.mock('electron', () => ({ ...electron, Notification: electron.FakeNotification }))
vi.mock('./app-icon', () => ({ appIconPath: () => '/icons/icon.png' }))

const { createWindowBehaviour } = await import('./window-behaviour')

class FakeWindow extends EventEmitter {
  focused = false
  minimized = false
  flashes: boolean[] = []
  webContents = new EventEmitter()
  isFocused = () => this.focused
  isDestroyed = () => false
  isMinimized = () => this.minimized
  isVisible = () => true
  restore = vi.fn(() => {
    this.minimized = false
  })
  show = vi.fn()
  focus = vi.fn(() => {
    this.focused = true
    this.emit('focus')
  })
  flashFrame = (on: boolean) => this.flashes.push(on)
  maximize = vi.fn()
  getNormalBounds = () => ({ x: 0, y: 0, width: 1000, height: 720 })
  isMaximized = () => false
  isFullScreen = () => false
  close = vi.fn()
}

const SECRET = 'C:\\Users\\me\\secret-plans.docx'
const approval: ApprovalPrompt = {
  id: 'a1',
  runId: 'r1',
  toolUseId: null,
  tool: 'write_file',
  kind: 'write',
  summary: `Write ${SECRET}`,
  detail: 'password=hunter2',
  origin: 'agent',
}

function setup(
  settings: { notifications?: boolean } = {},
  activity: () => { run: 'reply' | null; approvals: number } = () => ({ run: null, approvals: 0 }),
) {
  const config = { notifications: settings.notifications ?? true }
  const behaviour = createWindowBehaviour({
    activity,
    stopWork: () => Promise.resolve(),
    settings: {
      get windowState() {
        return undefined
      },
      setWindowState: () => Promise.resolve(),
      get notifications() {
        return config.notifications
      },
    },
  })
  const window = new FakeWindow()
  behaviour.attach(window as never, behaviour.plan())
  return { behaviour, window, config }
}

const reply = (text: string): ChatEvent[] => [
  { type: 'run_started', runId: 'r1', text: `my prompt ${text}` },
  { type: 'text_delta', runId: 'r1', turn: 1, text: `reply with ${text}` },
  { type: 'run_finished', runId: 'r1', stopReason: 'end_turn' },
]

describe('window behaviour: notifications and taskbar flash', () => {
  beforeEach(() => {
    electron.FakeNotification.shown.length = 0
    electron.FakeNotification.supported = true
  })

  it('notifies and flashes when a reply finishes behind the window', () => {
    const { behaviour, window } = setup()
    for (const event of reply('x')) behaviour.onPush(IpcChannels.chatEvent, event)
    expect(electron.FakeNotification.shown).toHaveLength(1)
    expect(electron.FakeNotification.shown[0]?.options).toEqual({
      title: 'Desktop Agent',
      body: 'Your reply is ready.',
      icon: '/icons/icon.png',
    })
    expect(window.flashes).toEqual([true])
  })

  it('stays silent while the window is focused', () => {
    const { behaviour, window } = setup()
    window.focused = true
    for (const event of reply('x')) behaviour.onPush(IpcChannels.chatEvent, event)
    behaviour.onPush(IpcChannels.approvalRequest, approval)
    expect(electron.FakeNotification.shown).toHaveLength(0)
    expect(window.flashes).toEqual([])
  })

  it('stays silent when the setting is off', () => {
    const { behaviour, window } = setup({ notifications: false })
    for (const event of reply('x')) behaviour.onPush(IpcChannels.chatEvent, event)
    behaviour.onPush(IpcChannels.approvalRequest, approval)
    expect(electron.FakeNotification.shown).toHaveLength(0)
    expect(window.flashes).toEqual([])
  })

  it('announces a failure', () => {
    const { behaviour } = setup()
    behaviour.onPush(IpcChannels.chatEvent, {
      type: 'error',
      runId: 'r1',
      code: 'network',
      message: `could not read ${SECRET}`,
    })
    expect(electron.FakeNotification.shown[0]?.options.body).toBe('A reply could not be completed.')
  })

  it('shows only fixed text: nothing from the prompt, reply, path or tool arguments', () => {
    const { behaviour } = setup()
    for (const event of reply(SECRET)) behaviour.onPush(IpcChannels.chatEvent, event)
    behaviour.onPush(IpcChannels.approvalRequest, approval)
    expect(electron.FakeNotification.shown).toHaveLength(2)
    for (const shown of electron.FakeNotification.shown) {
      const text = JSON.stringify(shown.options)
      expect(text).not.toContain('secret')
      expect(text).not.toContain('hunter2')
      expect(text).not.toContain('write_file')
      expect(text).not.toContain('prompt')
    }
    expect(electron.FakeNotification.shown[1]?.options.body).toBe(
      'An approval is waiting for your answer.',
    )
  })

  it('does not repeat for the same approval', () => {
    const { behaviour } = setup()
    behaviour.onPush(IpcChannels.approvalRequest, approval)
    behaviour.onPush(IpcChannels.approvalRequest, approval)
    expect(electron.FakeNotification.shown).toHaveLength(1)
    behaviour.onPush(IpcChannels.approvalRequest, { ...approval, id: 'a2' })
    expect(electron.FakeNotification.shown).toHaveLength(2)
  })

  it('clicking the notification only brings the window back; nothing is approved', () => {
    const { behaviour, window } = setup()
    window.minimized = true
    behaviour.onPush(IpcChannels.approvalRequest, approval)
    electron.FakeNotification.shown[0]?.handlers.get('click')?.()
    expect(window.restore).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
    // The behaviour has no way to answer an approval: it is given none.
    expect(Object.keys(behaviour).sort()).toEqual(['allowQuit', 'attach', 'onPush', 'plan'])
  })

  it('stops flashing when the window gets focus', () => {
    const { behaviour, window } = setup()
    behaviour.onPush(IpcChannels.approvalRequest, approval)
    window.focus()
    expect(window.flashes).toEqual([true, false])
  })

  it('still flashes when the system cannot show notifications', () => {
    electron.FakeNotification.supported = false
    const { behaviour, window } = setup()
    behaviour.onPush(IpcChannels.approvalRequest, approval)
    expect(electron.FakeNotification.shown).toHaveLength(0)
    expect(window.flashes).toEqual([true])
  })
})

describe('window behaviour: the close warning and the system', () => {
  const working = () => ({ run: 'reply' as const, approvals: 1 })
  const requestClose = (window: FakeWindow): { preventDefault: ReturnType<typeof vi.fn> } => {
    const event = { preventDefault: vi.fn() }
    window.emit('close', event)
    return event
  }

  beforeEach(() => {
    electron.dialog.showMessageBox.mockReset()
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks while work is in progress, in a dialog that is not a child of the window', async () => {
    const { window } = setup({}, working)
    expect(requestClose(window).preventDefault).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    // One argument: options only, so no window is the parent and an approval stays answerable.
    expect(electron.dialog.showMessageBox.mock.calls[0]).toHaveLength(1)
    expect(electron.dialog.showMessageBox.mock.calls[0]?.[0]).toMatchObject({
      buttons: ['Cancel', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
    })
  })

  it('does not ask once Windows says the session is ending, and does not hold the close', async () => {
    const { window } = setup({}, working)
    window.emit('session-end')
    expect(requestClose(window).preventDefault).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('still asks after a query-session-end, which Windows may cancel', async () => {
    const { window } = setup({}, working)
    window.emit('query-session-end')
    expect(requestClose(window).preventDefault).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('does not ask after a query-session-end that is followed by the confirmed session-end', async () => {
    const { window } = setup({}, working)
    window.emit('query-session-end')
    window.emit('session-end')
    expect(requestClose(window).preventDefault).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('does not ask at an operating-system shutdown on Linux or macOS', () => {
    const { window } = setup({}, working)
    const onShutdown = electron.powerMonitor.on.mock.calls.find(([name]) => name === 'shutdown')
    ;(onShutdown?.[1] as () => void)()
    expect(requestClose(window).preventDefault).not.toHaveBeenCalled()
  })

  it('does not ask while the page is hung, and asks again once it responds', () => {
    const { window } = setup({}, working)
    window.webContents.emit('unresponsive')
    expect(requestClose(window).preventDefault).not.toHaveBeenCalled()
    window.webContents.emit('responsive')
    expect(requestClose(window).preventDefault).toHaveBeenCalled()
  })
})
