import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  IpcChannels,
  type ApprovalPrompt,
  type ChatEvent,
  type ThemePreference,
} from '../shared/ipc'
import { commandChannels } from '../shared/ipc-command'
import { BUILTIN_CONNECTIONS, connectionsChannels } from '../shared/ipc-connections'
import { FEATURE_CHANNELS } from '../shared/ipc-features'
import { filesChannels, filesPushChannels } from '../shared/ipc-files'
import { gitChannels } from '../shared/ipc-git'
import { DEFAULT_LAYOUT, layoutChannels, type LayoutPrefs } from '../shared/ipc-layout'
import { projectsChannels, type ProjectsState } from '../shared/ipc-projects'
import type { RunOptions } from './agent'
import { cancelOnPageEnd } from './chat/lifecycle'
import { ChatSession } from './chat/session'
import { memoryHistory, memoryStore } from './chat/test-support'
import {
  registerIpcHandlers,
  type IpcMainLike,
  type IpcSenderEvent,
  type IpcServices,
} from './ipc-handlers'
import { isTrustedIpcSender, isTrustedSenderFrame } from './security'

const APP_URL = 'file:///C:/Program%20Files/Desktop%20Agent/resources/app/out/renderer/index.html'
const appFrame: IpcSenderEvent = { senderFrame: { url: APP_URL, parent: null } }
const OTHER_CHAT = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
const ROOT_ID = 'r0123456789abcdef'

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

const PROJECT = '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b'
const projectsState: ProjectsState = { provider: 'anthropic-api', projects: [], others: [] }
function fakeProjects(): IpcServices['projects'] {
  const state = () => Promise.resolve(projectsState)
  const status = { provider: 'codex-subscription' as const, state: 'ready' as const, message: '' }
  return {
    state: vi.fn(state),
    create: vi.fn(() =>
      Promise.resolve({ project: { id: PROJECT, name: 'P', icon: null }, state: projectsState }),
    ),
    rename: vi.fn(state),
    remove: vi.fn(state),
    move: vi.fn(state),
    pin: vi.fn(state),
    archive: vi.fn(state),
    moveChat: vi.fn(state),
    fork: vi.fn(() =>
      Promise.resolve({
        chat: { provider: 'anthropic-api' as const, id: OTHER_CHAT },
        state: projectsState,
      }),
    ),
    renameChat: vi.fn(state),
    removeChat: vi.fn(state),
    open: vi.fn(() => Promise.resolve(status)),
  }
}

function fakeServices(overrides: Partial<IpcServices> = {}) {
  let roots: string[] = ['/granted']
  const status = { provider: 'anthropic-api' as const, state: 'ready' as const, message: 'API' }
  const services: IpcServices = {
    provider: {
      models: vi.fn(),
      setModel: vi.fn(),
      allowance: vi.fn(),
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
    connections: {
      list: vi.fn(() => []),
      available: vi.fn((id: string) => BUILTIN_CONNECTIONS.includes(id)),
      state: vi.fn(() => ({
        configured: ['anthropic-api'],
        current: 'anthropic-api',
        showPersonalUse: true,
      })),
      status: vi.fn((provider: string) =>
        Promise.resolve({ provider, state: 'ready' as const, message: 'Ready.' }),
      ),
      add: vi.fn(() =>
        Promise.resolve({ configured: [], current: 'anthropic-api', showPersonalUse: true }),
      ),
      remove: vi.fn(() =>
        Promise.resolve({ configured: [], current: 'anthropic-api', showPersonalUse: true }),
      ),
      setShowPersonalUse: vi.fn(() =>
        Promise.resolve({ configured: [], current: 'anthropic-api', showPersonalUse: false }),
      ),
    },
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
      historyState: vi.fn(() => ({ conversations: [], activeId: null })),
      open: vi.fn(() => Promise.resolve({ items: [], running: false, loadError: null })),
      rename: vi.fn(() => Promise.resolve({ conversations: [], activeId: null })),
      remove: vi.fn(() => Promise.resolve({ conversations: [], activeId: null })),
      respondApproval: vi.fn(() => true),
    },
    command: {
      run: vi.fn(() => Promise.resolve({ ok: true as const })),
    },
    files: {
      roots: vi.fn(() => [{ id: ROOT_ID, name: 'granted', path: '/granted' }]),
      list: vi.fn(() => Promise.resolve({ ok: true as const, entries: [], more: 0 })),
      watch: vi.fn(() => Promise.resolve()),
      search: vi.fn(() => Promise.resolve([])),
      reveal: vi.fn(() => Promise.resolve({ ok: true as const })),
      copyPath: vi.fn(() => Promise.resolve({ ok: true as const })),
      reference: vi.fn(() => Promise.resolve({ ok: true as const, text: '@"/granted/a"' })),
    },
    git: {
      overview: vi.fn(() => Promise.resolve({ git: 'missing' as const })),
      status: vi.fn(() =>
        Promise.resolve({ ok: false as const, code: 'refused' as const, reason: 'no' }),
      ),
      diff: vi.fn(() => Promise.resolve({ ok: true as const, kind: 'empty' as const })),
      log: vi.fn(() => Promise.resolve({ ok: true as const, commits: [], more: false })),
      watch: vi.fn(() => Promise.resolve()),
      openInstallPage: vi.fn(() => Promise.resolve()),
    },
    layout: {
      get: vi.fn(() => ({ ...DEFAULT_LAYOUT })),
      set: vi.fn((layout: unknown) => Promise.resolve(layout as LayoutPrefs)),
    },
    projects: fakeProjects(),
    revealAudit: vi.fn(),
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
  it('reveals only the app audit log and rejects renderer paths', async () => {
    const revealAudit = vi.fn()
    const { invoke } = setup({ revealAudit })
    await invoke(IpcChannels.auditReveal, appFrame)
    expect(revealAudit).toHaveBeenCalledExactlyOnceWith()
    await expect(invoke(IpcChannels.auditReveal, appFrame, 'C:\\secret')).rejects.toThrow(
      'takes no arguments',
    )
    expect(revealAudit).toHaveBeenCalledTimes(1)
  })

  describe('layout', () => {
    it('answers the saved layout', async () => {
      const { invoke } = setup()
      expect(await invoke(layoutChannels.layoutGet, appFrame)).toEqual(DEFAULT_LAYOUT)
    })

    it('passes a layout object on and refuses anything else', async () => {
      const { invoke, services } = setup()
      const layout = { ...DEFAULT_LAYOUT, leftOpen: false }
      expect(await invoke(layoutChannels.layoutSet, appFrame, layout)).toEqual(layout)
      expect(services.layout.set).toHaveBeenCalledWith(layout)
      for (const bad of [undefined, null, 'C:\\Users', 7, ['x']])
        await expect(invoke(layoutChannels.layoutSet, appFrame, bad)).rejects.toThrow(
          'Invalid layout.',
        )
      expect(services.layout.set).toHaveBeenCalledOnce()
    })
  })

  describe('git', () => {
    const repo = { rootId: ROOT_ID, rel: '' }
    const badRepos = [
      undefined,
      null,
      'C:\\Users\\me\\repo',
      { rootId: ROOT_ID },
      { rootId: 'C:\\repo', rel: '' },
      { rootId: ROOT_ID, rel: 7 },
      { rootId: ROOT_ID, rel: '', path: '/etc' },
    ]

    it('passes valid requests on', async () => {
      const { invoke, services } = setup()
      expect(await invoke(gitChannels.gitOverview, appFrame)).toEqual({ git: 'missing' })
      await invoke(gitChannels.gitStatus, appFrame, repo)
      expect(services.git.status).toHaveBeenCalledWith(repo)
      const diff = { repo, area: 'staged', path: 'src/new.ts', oldPath: 'src/old.ts' }
      await invoke(gitChannels.gitDiff, appFrame, diff)
      expect(services.git.diff).toHaveBeenCalledWith(diff)
      await invoke(gitChannels.gitLog, appFrame, { repo, skip: 50 })
      expect(services.git.log).toHaveBeenCalledWith({ repo, skip: 50 })
      await invoke(gitChannels.gitWatch, appFrame, [repo])
      expect(services.git.watch).toHaveBeenCalledWith([repo])
      await invoke(gitChannels.gitOpenInstallPage, appFrame, 'https://evil.example/')
      // The renderer cannot choose the address: the service takes no argument.
      expect(services.git.openInstallPage).toHaveBeenCalledWith()
    })

    it('refuses anything that is not a repository location or a plain request', async () => {
      const { invoke, services } = setup()
      for (const bad of badRepos) {
        await expect(invoke(gitChannels.gitStatus, appFrame, bad)).rejects.toThrow(
          'Unknown repository.',
        )
        await expect(
          invoke(gitChannels.gitDiff, appFrame, { repo: bad, area: 'staged', path: 'a' }),
        ).rejects.toThrow('Invalid diff request.')
        await expect(invoke(gitChannels.gitLog, appFrame, { repo: bad, skip: 0 })).rejects.toThrow(
          'Invalid history request.',
        )
      }
      for (const bad of [
        { repo, area: 'all', path: 'a' },
        { repo, area: 'staged', path: '' },
        { repo, area: 'staged', path: 'x'.repeat(5000) },
        { repo, area: 'staged', path: 'a', args: ['--output=/tmp/x'] },
      ])
        await expect(invoke(gitChannels.gitDiff, appFrame, bad)).rejects.toThrow(
          'Invalid diff request.',
        )
      for (const skip of [-1, 1.5, 10_000_000, '0'])
        await expect(invoke(gitChannels.gitLog, appFrame, { repo, skip })).rejects.toThrow(
          'Invalid history request.',
        )
      await expect(
        invoke(
          gitChannels.gitWatch,
          appFrame,
          Array.from({ length: 100 }, () => repo),
        ),
      ).rejects.toThrow('Invalid repositories to watch.')
      expect(services.git.status).not.toHaveBeenCalled()
      expect(services.git.diff).not.toHaveBeenCalled()
      expect(services.git.log).not.toHaveBeenCalled()
      expect(services.git.watch).not.toHaveBeenCalled()
    })
  })

  describe('command', () => {
    it('hands a typed command and folder to the command service', async () => {
      const { invoke, services } = setup()
      expect(await invoke(commandChannels.commandRun, appFrame, 'dir', 'C:\\work')).toEqual({
        ok: true,
      })
      expect(services.command.run).toHaveBeenCalledExactlyOnceWith('dir', 'C:\\work')
    })

    it('refuses anything but a non-empty command and a folder string', async () => {
      const { invoke, services } = setup()
      const bad: unknown[][] = [
        [],
        ['dir'],
        ['dir', 'C:\\work', 'extra'],
        ['', 'C:\\work'],
        ['   ', 'C:\\work'],
        ['x'.repeat(8001), 'C:\\work'],
        [{ command: 'dir' }, 'C:\\work'],
        ['dir', ''],
        ['dir', 7],
        ['dir', 'C:\\work\0'],
        ['dir', ['C:\\work']],
      ]
      for (const args of bad)
        await expect(invoke(commandChannels.commandRun, appFrame, ...args)).rejects.toThrow(
          /Invalid (command|folder)\./,
        )
      expect(services.command.run).not.toHaveBeenCalled()
    })
  })

  describe('files', () => {
    const at = { rootId: ROOT_ID, rel: 'src/main.ts' }
    const badLocations = [
      undefined,
      null,
      'C:\\Users\\me\\notes.txt',
      '/etc/passwd',
      { rootId: ROOT_ID },
      { rootId: 'C:\\Users', rel: '' },
      { rootId: '../r0123456789abcdef', rel: '' },
      { rootId: ROOT_ID, rel: 7 },
      { rootId: ROOT_ID, rel: 'x'.repeat(5000) },
      { rootId: ROOT_ID, rel: '', path: 'C:\\Windows' },
    ]

    it('lists roots and passes valid locations on', async () => {
      const { invoke, services } = setup()
      expect(await invoke(filesChannels.filesRoots, appFrame)).toEqual([
        { id: ROOT_ID, name: 'granted', path: '/granted' },
      ])
      for (const [channel, call] of [
        [filesChannels.filesList, services.files.list],
        [filesChannels.filesReveal, services.files.reveal],
        [filesChannels.filesCopyPath, services.files.copyPath],
        [filesChannels.filesReference, services.files.reference],
      ] as const) {
        await invoke(channel, appFrame, at)
        expect(call).toHaveBeenCalledWith(at)
      }
    })

    it.each([
      filesChannels.filesList,
      filesChannels.filesReveal,
      filesChannels.filesCopyPath,
      filesChannels.filesReference,
    ])('%s refuses anything but a root id and a relative path', async (channel) => {
      const { invoke, services } = setup()
      for (const bad of badLocations)
        await expect(invoke(channel, appFrame, bad)).rejects.toThrow('Unknown file.')
      expect(services.files.list).not.toHaveBeenCalled()
      expect(services.files.reveal).not.toHaveBeenCalled()
      expect(services.files.copyPath).not.toHaveBeenCalled()
      expect(services.files.reference).not.toHaveBeenCalled()
    })

    it('watches a bounded list of locations', async () => {
      const { invoke, services } = setup()
      await invoke(filesChannels.filesWatch, appFrame, [at])
      expect(services.files.watch).toHaveBeenCalledWith([at])
      for (const bad of [at, 'src', [at, '/etc'], Array.from({ length: 1000 }, () => at)])
        await expect(invoke(filesChannels.filesWatch, appFrame, bad)).rejects.toThrow(
          'Invalid folders to watch.',
        )
      expect(services.files.watch).toHaveBeenCalledOnce()
    })

    it('searches with a bounded string query', async () => {
      const { invoke, services } = setup()
      await invoke(filesChannels.filesSearch, appFrame, 'main')
      expect(services.files.search).toHaveBeenCalledWith('main')
      for (const bad of [undefined, 7, { q: 'x' }, 'x'.repeat(201)])
        await expect(invoke(filesChannels.filesSearch, appFrame, bad)).rejects.toThrow(
          'Invalid search.',
        )
    })
  })

  describe('projects', () => {
    const chat = { provider: 'codex-subscription', id: OTHER_CHAT }
    const c = projectsChannels

    it('passes valid calls through', async () => {
      const { invoke, services } = setup()
      const p = services.projects
      await invoke(c.projectsState, appFrame)
      await invoke(c.projectsCreate, appFrame, 'Taxes', '📊')
      expect(p.create).toHaveBeenCalledWith('Taxes', '📊')
      await invoke(c.projectsRename, appFrame, PROJECT, 'Tax', null)
      expect(p.rename).toHaveBeenCalledWith(PROJECT, 'Tax', null)
      await invoke(c.projectsMove, appFrame, PROJECT, 'top')
      expect(p.move).toHaveBeenCalledWith(PROJECT, 'top')
      await invoke(c.projectsDelete, appFrame, PROJECT)
      expect(p.remove).toHaveBeenCalledWith(PROJECT)
      await invoke(c.chatPin, appFrame, chat, true)
      expect(p.pin).toHaveBeenCalledWith(chat, true)
      await invoke(c.chatArchive, appFrame, chat, false)
      expect(p.archive).toHaveBeenCalledWith(chat, false)
      await invoke(c.chatMove, appFrame, chat, PROJECT)
      await invoke(c.chatMove, appFrame, chat, null)
      expect(p.moveChat).toHaveBeenLastCalledWith(chat, null)
      await invoke(c.chatFork, appFrame, chat, 2)
      await invoke(c.chatFork, appFrame, chat, null)
      expect(p.fork).toHaveBeenLastCalledWith(chat, null)
      await invoke(c.chatRename, appFrame, chat, 'Name')
      expect(p.renameChat).toHaveBeenCalledWith(chat, 'Name')
      await invoke(c.chatDelete, appFrame, chat)
      expect(p.removeChat).toHaveBeenCalledWith(chat)
      expect(await invoke(c.chatOpen, appFrame, chat)).toMatchObject({
        provider: 'codex-subscription',
      })
    })

    it('refuses bad ids, providers, names, icons and flags before reaching a store', async () => {
      const { invoke, services } = setup()
      const badChats = [
        undefined,
        null,
        OTHER_CHAT,
        { provider: 'codex-subscription', id: '../../settings' },
        { provider: 'codex-subscription', id: 'C:\\Users\\me\\x.json' },
        { provider: 'evil', id: OTHER_CHAT },
        { provider: 'codex-subscription', id: OTHER_CHAT, path: '/etc/passwd' },
        [OTHER_CHAT],
      ]
      for (const bad of badChats) {
        for (const [channel, ...args] of [
          [c.chatPin, bad, true],
          [c.chatArchive, bad, true],
          [c.chatMove, bad, null],
          [c.chatFork, bad, null],
          [c.chatRename, bad, 'x'],
          [c.chatDelete, bad],
          [c.chatOpen, bad],
        ] as const)
          await expect(invoke(channel, appFrame, ...args)).rejects.toThrow('Unknown chat.')
      }
      for (const bad of ['../x', 'P1', 7, null, undefined]) {
        await expect(invoke(c.projectsDelete, appFrame, bad)).rejects.toThrow('Unknown project.')
        await expect(invoke(c.chatMove, appFrame, chat, bad === null ? 'x' : bad)).rejects.toThrow(
          'Unknown project.',
        )
      }
      await expect(invoke(c.projectsCreate, appFrame, 'x'.repeat(1001), null)).rejects.toThrow(
        'Enter a shorter name.',
      )
      await expect(invoke(c.projectsCreate, appFrame, 'x', '💣')).rejects.toThrow('Unknown icon.')
      await expect(invoke(c.projectsCreate, appFrame, 5, null)).rejects.toThrow()
      await expect(invoke(c.projectsMove, appFrame, PROJECT, 'sideways')).rejects.toThrow(
        'Invalid move.',
      )
      await expect(invoke(c.chatPin, appFrame, chat, 'yes')).rejects.toThrow('Invalid choice.')
      for (const bad of [0, -1, 1.5, '2', Infinity])
        await expect(invoke(c.chatFork, appFrame, chat, bad)).rejects.toThrow('Invalid fork point.')
      for (const fn of Object.values(services.projects))
        if (fn !== services.projects.state) expect(fn).not.toHaveBeenCalled()
    })
  })

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
      filesPushChannels.filesChanged,
    ])
    const expected = [
      ...Object.values(IpcChannels).filter((channel) => !pushes.has(channel)),
      ...FEATURE_CHANNELS,
    ]
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
    for (const fn of Object.values(services.projects)) expect(fn).not.toHaveBeenCalled()
  })

  it.each(untrusted)('never runs a command for an untrusted frame (%j)', async (event) => {
    const { invoke, services } = setup()
    await expect(invoke(commandChannels.commandRun, event, 'dir', 'C:\\work')).rejects.toThrow(
      'Rejected IPC from untrusted frame',
    )
    expect(services.command.run).not.toHaveBeenCalled()
  })

  describe('API key', () => {
    it('reports status without ever returning the key', async () => {
      const hasKey = vi.fn(() => Promise.resolve(true))
      const { invoke, services } = setup()
      services.apiKey.hasKey = hasKey
      const result = await invoke(IpcChannels.apiKeySet, appFrame, '  sk-ant-secret  ')
      expect(services.apiKey.set).toHaveBeenCalledWith('sk-ant-secret', undefined)
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

    it('passes a named connection through only when the registry offers it', async () => {
      const { invoke, services } = setup()
      await invoke(IpcChannels.apiKeySet, appFrame, 'sk', 'anthropic-api')
      expect(services.apiKey.set).toHaveBeenCalledWith('sk', 'anthropic-api')
      await invoke(IpcChannels.apiKeyStatus, appFrame, 'anthropic-api')
      expect(services.apiKey.hasKey).toHaveBeenLastCalledWith('anthropic-api')
      for (const bad of ['../anthropic-api', 'openai-api', 7, null, '__proto__']) {
        await expect(invoke(IpcChannels.apiKeySet, appFrame, 'sk', bad)).rejects.toThrow(
          'Unknown provider.',
        )
        await expect(invoke(IpcChannels.apiKeyStatus, appFrame, bad)).rejects.toThrow(
          'Unknown provider.',
        )
        await expect(invoke(IpcChannels.apiKeyClear, appFrame, bad)).rejects.toThrow(
          'Unknown provider.',
        )
      }
      expect(services.apiKey.set).toHaveBeenCalledOnce()
      expect(services.apiKey.clear).not.toHaveBeenCalled()
    })

    it.each([
      ['still saved', () => Promise.resolve(true), true],
      ['gone', () => Promise.resolve(false), false],
      ['unreadable', () => Promise.reject(new Error('Stored API key is corrupt.')), false],
    ] as const)(
      'reports the stored state after a failed clear (key %s)',
      async (_name, hasKey, saved) => {
        const { invoke, services } = setup()
        services.apiKey.clear = () =>
          Promise.reject(new Error('Could not clear the encrypted API key.'))
        services.apiKey.hasKey = hasKey
        expect(await invoke(IpcChannels.apiKeyClear, appFrame)).toEqual({
          saved,
          error: 'Could not clear the encrypted API key.',
        })
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

  it('passes history calls through only with a valid id and title', async () => {
    const { invoke, services } = setup()
    await invoke(IpcChannels.chatHistory, appFrame)
    await invoke(IpcChannels.chatOpen, appFrame, OTHER_CHAT)
    await invoke(IpcChannels.chatRename, appFrame, OTHER_CHAT, 'Plans')
    await invoke(IpcChannels.chatDelete, appFrame, OTHER_CHAT)
    expect(services.chat.historyState).toHaveBeenCalledOnce()
    expect(services.chat.open).toHaveBeenCalledWith(OTHER_CHAT)
    expect(services.chat.rename).toHaveBeenCalledWith(OTHER_CHAT, 'Plans')
    expect(services.chat.remove).toHaveBeenCalledWith(OTHER_CHAT)

    const badIds = [
      '../index',
      '..\\..\\settings',
      `${OTHER_CHAT}/../x`,
      `${OTHER_CHAT}.json`,
      OTHER_CHAT.toUpperCase(),
      'index',
      '',
      42,
      null,
      { id: OTHER_CHAT },
    ]
    for (const id of badIds) {
      for (const channel of [IpcChannels.chatOpen, IpcChannels.chatDelete]) {
        await expect(invoke(channel, appFrame, id)).rejects.toThrow('Unknown chat.')
      }
      await expect(invoke(IpcChannels.chatRename, appFrame, id, 'x')).rejects.toThrow(
        'Unknown chat.',
      )
    }
    for (const title of [42, null, 'x'.repeat(1001)]) {
      await expect(invoke(IpcChannels.chatRename, appFrame, OTHER_CHAT, title)).rejects.toThrow()
    }
    for (const channel of [
      IpcChannels.chatHistory,
      IpcChannels.chatOpen,
      IpcChannels.chatRename,
      IpcChannels.chatDelete,
    ]) {
      await expect(
        invoke(
          channel,
          { senderFrame: { url: 'https://evil.example/', parent: null } },
          OTHER_CHAT,
        ),
      ).rejects.toThrow('untrusted')
    }
    expect(services.chat.open).toHaveBeenCalledOnce()
    expect(services.chat.rename).toHaveBeenCalledOnce()
    expect(services.chat.remove).toHaveBeenCalledOnce()
  })
})

describe('approvals over IPC with a real session', () => {
  function sessionSetup() {
    const prompts: ApprovalPrompt[] = []
    const events: ChatEvent[] = []
    const decisions: boolean[] = []
    let ids = 0
    const history = memoryHistory()
    history.add(OTHER_CHAT, memoryStore([{ role: 'user', content: 'other' }]))
    const chat = new ChatSession({
      history,
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

  it.each([
    'stop',
    'new chat',
    'opening another chat',
    'window reload',
    'renderer crash',
    'window close',
  ] as const)('denies a pending approval on %s', async (how) => {
    const { chat, invoke, decisions, pending } = sessionSetup()
    const contents = new EventEmitter()
    cancelOnPageEnd(contents, () => {
      void chat.stop()
    })
    await invoke(IpcChannels.chatSend, appFrame, 'delete it')
    await pending()
    if (how === 'stop') await invoke(IpcChannels.chatStop, appFrame)
    else if (how === 'new chat') await invoke(IpcChannels.chatNew, appFrame)
    else if (how === 'opening another chat')
      await invoke(IpcChannels.chatOpen, appFrame, OTHER_CHAT)
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
  })
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
  it('refuses a well-formed id the registry does not offer (unknown, or hidden)', async () => {
    const { invoke, services } = setup()
    for (const value of ['openai-api', 'claude-subscription']) {
      vi.mocked(services.connections.available).mockReturnValueOnce(false)
      await expect(invoke(IpcChannels.providerSet, appFrame, value)).rejects.toThrow(
        'Unknown provider',
      )
    }
    expect(services.provider.set).not.toHaveBeenCalled()
  })
  it('lists the connections main offers, taking no arguments', async () => {
    const { invoke, services } = setup()
    expect(await invoke(connectionsChannels.connectionsList, appFrame)).toEqual([])
    await expect(invoke(connectionsChannels.connectionsList, appFrame, true)).rejects.toThrow(
      'takes no arguments',
    )
    expect(services.connections.list).toHaveBeenCalledOnce()
  })
  it('checks every id the connection calls take against the registry, and their arguments', async () => {
    const { invoke, services } = setup()
    for (const channel of [
      connectionsChannels.connectionsStatus,
      connectionsChannels.connectionsAdd,
      connectionsChannels.connectionsRemove,
    ]) {
      for (const value of ['../x', 'C:\\Windows', 7, undefined, 'UPPER']) {
        await expect(invoke(channel, appFrame, value)).rejects.toThrow('Unknown provider')
      }
      await expect(invoke(channel, appFrame, 'anthropic-api', 'extra')).rejects.toThrow(
        'Unknown provider',
      )
      vi.mocked(services.connections.available).mockReturnValueOnce(false)
      await expect(invoke(channel, appFrame, 'openai-api')).rejects.toThrow('Unknown provider')
    }
    expect(services.connections.status).not.toHaveBeenCalled()
    expect(services.connections.add).not.toHaveBeenCalled()
    expect(services.connections.remove).not.toHaveBeenCalled()
    await invoke(connectionsChannels.connectionsStatus, appFrame, 'codex-subscription')
    await invoke(connectionsChannels.connectionsAdd, appFrame, 'codex-subscription')
    await invoke(connectionsChannels.connectionsRemove, appFrame, 'codex-subscription')
    expect(services.connections.status).toHaveBeenCalledWith('codex-subscription')
    expect(services.connections.add).toHaveBeenCalledWith('codex-subscription')
    expect(services.connections.remove).toHaveBeenCalledWith('codex-subscription')
  })
  it('reads the connection state with no arguments and sets personal use from a boolean only', async () => {
    const { invoke, services } = setup()
    expect(await invoke(connectionsChannels.connectionsState, appFrame)).toMatchObject({
      current: 'anthropic-api',
    })
    await expect(invoke(connectionsChannels.connectionsState, appFrame, 1)).rejects.toThrow(
      'takes no arguments',
    )
    for (const value of ['false', 0, null, undefined]) {
      await expect(
        invoke(connectionsChannels.connectionsSetShowPersonalUse, appFrame, value),
      ).rejects.toThrow('Invalid choice')
    }
    expect(services.connections.setShowPersonalUse).not.toHaveBeenCalled()
    await invoke(connectionsChannels.connectionsSetShowPersonalUse, appFrame, false)
    expect(services.connections.setShowPersonalUse).toHaveBeenCalledWith(false)
  })
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

it('validates subscription model IPC and keeps all metadata channels behind the sender gate', async () => {
  const { invoke, services } = setup()
  await invoke(IpcChannels.providerModels, appFrame)
  await invoke(IpcChannels.providerAllowance, appFrame)
  await invoke(IpcChannels.providerSetModel, appFrame, 'gpt-5.6-terra')
  await invoke(IpcChannels.providerSetModel, appFrame, null)
  expect(services.provider.models).toHaveBeenCalledOnce()
  expect(services.provider.allowance).toHaveBeenCalledOnce()
  expect(services.provider.setModel).toHaveBeenNthCalledWith(1, 'gpt-5.6-terra')
  expect(services.provider.setModel).toHaveBeenNthCalledWith(2, null)
  for (const value of [{ model: 'gpt-5.6-terra' }, 42, 'bad\nmodel', 'C:/private']) {
    expect(await invoke(IpcChannels.providerSetModel, appFrame, value)).toMatchObject({
      ok: false,
      failure: { code: 'model_unavailable' },
    })
  }
  for (const channel of [
    IpcChannels.providerModels,
    IpcChannels.providerAllowance,
    IpcChannels.providerSetModel,
  ]) {
    await expect(
      invoke(
        channel,
        { senderFrame: { url: 'https://evil.example', parent: null } },
        'gpt-5.6-terra',
      ),
    ).rejects.toThrow()
  }
  expect(services.provider.setModel).toHaveBeenCalledTimes(2)
})
