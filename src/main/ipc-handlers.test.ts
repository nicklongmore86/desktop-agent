import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  IpcChannels,
  type ApprovalPrompt,
  type ChatEvent,
  type ThemePreference,
} from '../shared/ipc'
import type { RunOptions } from './agent'
import { cancelOnPageEnd } from './chat/lifecycle'
import { ChatSession } from './chat/session'
import {
  registerIpcHandlers,
  type IpcMainLike,
  type IpcSenderEvent,
  type IpcServices,
} from './ipc-handlers'
import { isTrustedIpcSender, isTrustedSenderFrame } from './security'

const APP_URL = 'file:///C:/Program%20Files/Desktop%20Agent/resources/app/out/renderer/index.html'
const appFrame: IpcSenderEvent = { senderFrame: { url: APP_URL, parent: null } }

function fakeIpc() {
  const handlers = new Map<string, (event: IpcSenderEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainLike = {
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`duplicate handler ${channel}`)
      handlers.set(channel, listener)
    },
  }
  const invoke = (channel: string, event: IpcSenderEvent, ...args: unknown[]) =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler ${channel}`)
      return handler(event, ...args)
    })
  return { ipc, handlers, invoke }
}

function fakeServices(overrides: Partial<IpcServices> = {}) {
  let roots: string[] = ['/granted']
  const status = { provider: 'anthropic-api' as const, state: 'ready' as const, message: 'API' }
  const services: IpcServices = {
    provider: {
      get: vi.fn(() => Promise.resolve(status)),
      set: vi.fn(() => Promise.resolve(status)),
      login: vi.fn(() => Promise.resolve(status)),
      cancelLogin: vi.fn(() => Promise.resolve()),
      loginState: vi.fn(() =>
        Promise.resolve({ provider: null, active: false, url: null, result: null }),
      ),
      openLoginUrl: vi.fn(() => Promise.resolve()),
      copyLoginUrl: vi.fn(() => Promise.resolve()),
      submitLoginCode: vi.fn(() => Promise.resolve({ ok: true as const })),
    },
    appInfo: () => ({ name: 'desktop-agent', version: '0.1.0', platform: 'win32' }),
    apiKey: {
      hasKey: vi.fn(() => Promise.resolve(false)),
      set: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve()),
    },
    grants: {
      list: () => roots,
      loadError: null,
      add: vi.fn((folder: string) => {
        roots = [...roots, folder]
        return Promise.resolve({ ok: true as const, root: folder })
      }),
      remove: vi.fn((folder: string) => {
        roots = roots.filter((root) => root !== folder)
        return Promise.resolve(true)
      }),
    },
    pickFolder: vi.fn(() => Promise.resolve<string | null>('/picked')),
    settings: {
      theme: 'system' as const,
      setTheme: vi.fn((theme: ThemePreference) => Promise.resolve(theme)),
      view: () => ({ model: 'm', defaultModel: 'm', options: [{ id: 'm', label: 'M' }] }),
      setModel: vi.fn(() =>
        Promise.resolve({ model: 'm', defaultModel: 'm', options: [{ id: 'm', label: 'M' }] }),
      ),
    },
    chat: {
      state: () => ({ items: [], running: false, loadError: null }),
      send: vi.fn(() => Promise.resolve({ ok: true as const })),
      stop: vi.fn(() => Promise.resolve()),
      newChat: vi.fn(() => Promise.resolve({ items: [], running: false, loadError: null })),
      respondApproval: vi.fn(() => true),
    },
    audit: () => ({ healthy: true, path: '/data/audit.jsonl' }),
    ...overrides,
  }
  return services
}

function setup(overrides: Partial<IpcServices> = {}) {
  const { ipc, handlers, invoke } = fakeIpc()
  const services = fakeServices(overrides)
  registerIpcHandlers(ipc, (event) => isTrustedSenderFrame(event.senderFrame, APP_URL), services)
  return { handlers, invoke, services }
}

describe('isTrustedSenderFrame', () => {
  it('accepts only the app page in a top-level frame', () => {
    expect(isTrustedSenderFrame({ url: APP_URL, parent: null }, APP_URL)).toBe(true)
    expect(isTrustedSenderFrame({ url: `${APP_URL}#settings`, parent: null }, APP_URL)).toBe(true)
    expect(isTrustedSenderFrame({ url: 'https://example.com/', parent: null }, APP_URL)).toBe(false)
    expect(isTrustedSenderFrame({ url: 'file:///C:/other.html', parent: null }, APP_URL)).toBe(
      false,
    )
    expect(isTrustedSenderFrame({ url: APP_URL, parent: {} }, APP_URL)).toBe(false)
    expect(isTrustedSenderFrame(null, APP_URL)).toBe(false)
    expect(isTrustedSenderFrame(undefined, APP_URL)).toBe(false)
  })
})

describe('isTrustedIpcSender', () => {
  it("accepts only the app window's current main frame object", () => {
    const mainFrame = { url: APP_URL, parent: null }
    expect(isTrustedIpcSender(mainFrame, mainFrame, APP_URL)).toBe(true)
    // Same URL and top-level, but another window's (or a stale) frame.
    expect(isTrustedIpcSender({ url: APP_URL, parent: null }, mainFrame, APP_URL)).toBe(false)
    expect(isTrustedIpcSender(null, mainFrame, APP_URL)).toBe(false)
    expect(isTrustedIpcSender(mainFrame, undefined, APP_URL)).toBe(false)
    // The right frame object, but it has navigated away from the app.
    const navigated = { url: 'https://evil.example/', parent: null }
    expect(isTrustedIpcSender(navigated, navigated, APP_URL)).toBe(false)
  })
})

describe('registerIpcHandlers', () => {
  const untrusted: IpcSenderEvent[] = [
    { senderFrame: { url: 'https://evil.example/', parent: null } },
    { senderFrame: { url: APP_URL, parent: { url: APP_URL } } },
    { senderFrame: null },
  ]

  it('registers every renderer -> main channel', () => {
    const { handlers } = setup()
    const pushes = new Set<string>([
      IpcChannels.chatEvent,
      IpcChannels.approvalRequest,
      IpcChannels.auditStatusChanged,
      IpcChannels.providerLoginStateChanged,
    ])
    const expected = Object.values(IpcChannels).filter((channel) => !pushes.has(channel))
    expect([...handlers.keys()].sort()).toEqual([...expected].sort())
  })

  it.each(untrusted)('rejects every channel from an untrusted frame (%j)', async (event) => {
    const { handlers, invoke, services } = setup()
    for (const channel of handlers.keys()) {
      await expect(invoke(channel, event, 'arg', true)).rejects.toThrow(
        'Rejected IPC from untrusted frame',
      )
    }
    expect(services.pickFolder).not.toHaveBeenCalled()
    expect(services.chat.send).not.toHaveBeenCalled()
    expect(services.chat.respondApproval).not.toHaveBeenCalled()
    expect(services.apiKey.set).not.toHaveBeenCalled()
    expect(services.grants.remove).not.toHaveBeenCalled()
  })

  describe('API key', () => {
    it('reports status without ever returning the key', async () => {
      const hasKey = vi.fn(() => Promise.resolve(true))
      const { invoke, services } = setup()
      services.apiKey.hasKey = hasKey
      const result = await invoke(IpcChannels.apiKeySet, appFrame, '  sk-ant-secret  ')
      expect(services.apiKey.set).toHaveBeenCalledWith('sk-ant-secret')
      expect(result).toEqual({ saved: true, error: null })
      expect(JSON.stringify(result)).not.toContain('sk-ant')
      expect(await invoke(IpcChannels.apiKeyStatus, appFrame)).toEqual({ saved: true, error: null })
    })

    it.each([[''], ['   '], [42], [null], ['x'.repeat(1001)]])(
      'refuses invalid key %j',
      async (key) => {
        const { invoke, services } = setup()
        expect(await invoke(IpcChannels.apiKeySet, appFrame, key)).toEqual({
          saved: false,
          error: 'Enter a valid API key.',
        })
        expect(services.apiKey.set).not.toHaveBeenCalled()
      },
    )

    it('surfaces store errors as status, not exceptions', async () => {
      const { invoke, services } = setup()
      services.apiKey.set = () => Promise.reject(new Error('OS encryption is unavailable.'))
      services.apiKey.hasKey = () => Promise.reject(new Error('Stored API key is corrupt.'))
      expect(await invoke(IpcChannels.apiKeySet, appFrame, 'sk')).toEqual({
        saved: false,
        error: 'OS encryption is unavailable.',
      })
      expect(await invoke(IpcChannels.apiKeyStatus, appFrame)).toEqual({
        saved: false,
        error: 'Stored API key is corrupt.',
      })
      expect(await invoke(IpcChannels.apiKeyClear, appFrame)).toMatchObject({ saved: false })
    })
  })

  describe('grants', () => {
    it('adds only the folder chosen in the native dialog, ignoring renderer arguments', async () => {
      const { invoke, services } = setup()
      const result = await invoke(IpcChannels.grantsAdd, appFrame, 'C:\\Users\\me\\.ssh')
      expect(services.pickFolder).toHaveBeenCalledOnce()
      expect(services.grants.add).toHaveBeenCalledExactlyOnceWith('/picked')
      expect(result).toEqual({
        status: 'added',
        root: '/picked',
        grants: { roots: ['/granted', '/picked'], loadError: null },
      })
    })

    it('does nothing when the dialog is cancelled', async () => {
      const { invoke, services } = setup({ pickFolder: () => Promise.resolve(null) })
      expect(await invoke(IpcChannels.grantsAdd, appFrame)).toEqual({
        status: 'cancelled',
        grants: { roots: ['/granted'], loadError: null },
      })
      expect(services.grants.add).not.toHaveBeenCalled()
    })

    it('reports a refused folder', async () => {
      const { invoke, services } = setup()
      services.grants.add = () => Promise.resolve({ ok: false, reason: 'Drive roots are refused.' })
      expect(await invoke(IpcChannels.grantsAdd, appFrame)).toMatchObject({
        status: 'refused',
        reason: 'Drive roots are refused.',
      })
    })

    it('removes only an existing grant', async () => {
      const { invoke, services } = setup()
      expect(await invoke(IpcChannels.grantsRemove, appFrame, '/elsewhere')).toEqual({
        roots: ['/granted'],
        loadError: null,
      })
      expect(await invoke(IpcChannels.grantsRemove, appFrame, 7)).toMatchObject({
        roots: ['/granted'],
      })
      expect(services.grants.remove).not.toHaveBeenCalled()
      expect(await invoke(IpcChannels.grantsRemove, appFrame, '/granted')).toEqual({
        roots: [],
        loadError: null,
      })
    })
  })

  it('validates the model type before saving', async () => {
    const { invoke, services } = setup()
    await expect(invoke(IpcChannels.modelSet, appFrame, { id: 'm' })).rejects.toThrow(
      'Unknown model.',
    )
    expect(services.settings.setModel).not.toHaveBeenCalled()
    await invoke(IpcChannels.modelSet, appFrame, 'm')
    expect(services.settings.setModel).toHaveBeenCalledWith('m')
  })

  it('validates the theme before saving it', async () => {
    const { invoke, services } = setup()
    expect(await invoke(IpcChannels.themeGet, appFrame)).toBe('system')
    for (const bad of ['sepia', 'DARK', 1, null, { theme: 'dark' }]) {
      await expect(invoke(IpcChannels.themeSet, appFrame, bad)).rejects.toThrow('Unknown theme.')
    }
    expect(services.settings.setTheme).not.toHaveBeenCalled()
    await invoke(IpcChannels.themeSet, appFrame, 'dark')
    expect(services.settings.setTheme).toHaveBeenCalledWith('dark')
  })

  it('passes chat calls and approval answers through to the session', async () => {
    const { invoke, services } = setup()
    await invoke(IpcChannels.chatSend, appFrame, 'hello')
    await invoke(IpcChannels.chatStop, appFrame)
    await invoke(IpcChannels.chatNew, appFrame)
    await invoke(IpcChannels.approvalRespond, appFrame, 'id-1', true)
    expect(services.chat.send).toHaveBeenCalledWith('hello')
    expect(services.chat.stop).toHaveBeenCalledOnce()
    expect(services.chat.newChat).toHaveBeenCalledOnce()
    expect(services.chat.respondApproval).toHaveBeenCalledWith('id-1', true)
  })
})

describe('approvals over IPC with a real session', () => {
  function sessionSetup() {
    const prompts: ApprovalPrompt[] = []
    const events: ChatEvent[] = []
    const decisions: boolean[] = []
    let ids = 0
    const chat = new ChatSession({
      store: {
        load: () => Promise.resolve({ messages: [], error: null }),
        save: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      createRunner: () =>
        Promise.resolve({
          ok: true,
          runner: {
            async run(conversation, options: RunOptions) {
              decisions.push(
                await options.requestApproval({
                  tool: 'delete_path',
                  kind: 'delete',
                  summary: 'Move file a.txt to the Recycle Bin',
                }),
              )
              return { conversation, stopReason: 'end_turn' }
            },
          },
        }),
      emit: (event) => events.push(event),
      promptApproval: (prompt) => prompts.push(prompt),
      newId: () => `approval-${String(++ids)}`,
    })
    const { ipc, invoke } = fakeIpc()
    registerIpcHandlers(ipc, (event) => isTrustedSenderFrame(event.senderFrame, APP_URL), {
      ...fakeServices(),
      chat,
    })
    const pending = async () => {
      for (let i = 0; i < 50 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r))
      const prompt = prompts[0]
      if (!prompt) throw new Error('no approval prompt')
      return prompt
    }
    return { chat, invoke, prompts, events, decisions, pending }
  }

  it('ignores answers from an untrusted frame or for the wrong id', async () => {
    const { chat, invoke, decisions, pending } = sessionSetup()
    await invoke(IpcChannels.chatSend, appFrame, 'delete it')
    const prompt = await pending()
    await expect(
      invoke(
        IpcChannels.approvalRespond,
        { senderFrame: { url: 'https://evil.example/', parent: null } },
        prompt.id,
        true,
      ),
    ).rejects.toThrow()
    await invoke(IpcChannels.approvalRespond, appFrame, 'approval-guess', true)
    await invoke(IpcChannels.approvalRespond, appFrame, prompt.runId, true)
    expect(chat.pendingApprovals).toEqual([prompt.id])
    expect(decisions).toEqual([])
    await invoke(IpcChannels.approvalRespond, appFrame, prompt.id, true)
    await chat.idle()
    expect(decisions).toEqual([true])
  })

  it.each(['stop', 'new chat', 'window reload', 'renderer crash', 'window close'] as const)(
    'denies a pending approval on %s',
    async (how) => {
      const { chat, invoke, decisions, pending } = sessionSetup()
      const contents = new EventEmitter()
      cancelOnPageEnd(contents, () => {
        void chat.stop()
      })
      await invoke(IpcChannels.chatSend, appFrame, 'delete it')
      await pending()
      if (how === 'stop') await invoke(IpcChannels.chatStop, appFrame)
      else if (how === 'new chat') await invoke(IpcChannels.chatNew, appFrame)
      else
        contents.emit(
          how === 'window reload'
            ? 'did-start-loading'
            : how === 'renderer crash'
              ? 'render-process-gone'
              : 'destroyed',
        )
      await chat.idle()
      expect(decisions).toEqual([false])
      expect(chat.pendingApprovals).toEqual([])
    },
  )
})

describe('provider IPC', () => {
  it.each([null, {}, 3, 'api-key-as-subscription', '__proto__'])(
    'rejects invalid provider %j',
    async (value) => {
      const { invoke, services } = setup()
      await expect(invoke(IpcChannels.providerSet, appFrame, value)).rejects.toThrow(
        'Unknown provider',
      )
      expect(services.provider.set).not.toHaveBeenCalled()
    },
  )
  it('accepts explicit provider selection only through trusted IPC', async () => {
    const { invoke, services } = setup()
    await invoke(IpcChannels.providerSet, appFrame, 'codex-subscription')
    expect(services.provider.set).toHaveBeenCalledWith('codex-subscription')
  })
  it('opens and copies only the link main validated, never a renderer-supplied URL', async () => {
    const { invoke, services } = setup()
    await invoke(IpcChannels.providerOpenLoginUrl, appFrame, 'https://evil.example/')
    await invoke(IpcChannels.providerCopyLoginUrl, appFrame, 'https://evil.example/')
    expect(services.provider.openLoginUrl).toHaveBeenCalledExactlyOnceWith()
    expect(services.provider.copyLoginUrl).toHaveBeenCalledExactlyOnceWith()
  })
  it.each([null, 3, {}, ['a#b']])('refuses a non-string sign-in code %j', async (value) => {
    const { invoke, services } = setup()
    expect(await invoke(IpcChannels.providerSubmitLoginCode, appFrame, value)).toMatchObject({
      ok: false,
    })
    expect(services.provider.submitLoginCode).not.toHaveBeenCalled()
  })
})
