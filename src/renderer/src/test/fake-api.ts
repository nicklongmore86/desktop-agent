import { vi } from 'vitest'
import type {
  ApiKeyStatus,
  ApprovalPrompt,
  AuditStatus,
  ChatEvent,
  ChatState,
  DesktopApi,
  GrantsState,
  HistoryState,
  ModelSettings,
  ProviderLoginState,
  ProviderStatus,
  ProviderId,
  ThemePreference,
} from '../../../shared/ipc'
import type {
  FileEntry,
  FileLocation,
  FilesChanged,
  FileSearchHit,
  FilesRoot,
} from '../../../shared/ipc-files'
import { DEFAULT_LAYOUT, type LayoutPrefs } from '../../../shared/ipc-layout'

/** A granted folder's fake id: stable per path, not the path. */
export function fakeRootId(root: string): string {
  let hash = 0
  for (const char of root) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `r${hash.toString(16).padStart(16, '0')}`
}

/** The folder listings the fake answers with, keyed `<granted folder>\n<relative path>`. */
export const FAKE_FILES: Record<string, FileEntry[]> = {
  'C:\\Users\\me\\Projects\n': [
    { name: 'src', rel: 'src', kind: 'dir' },
    { name: '.ssh', rel: '.ssh', kind: 'other', denied: '".ssh" is blocked (SSH keys).' },
    { name: 'escape', rel: 'escape', kind: 'link', linkOutside: true },
    { name: '.env', rel: '.env', kind: 'other', denied: '".env" is blocked (environment files).' },
    { name: 'README.md', rel: 'README.md', kind: 'file', size: 120 },
    { name: 'secrets.json', rel: 'secrets.json', kind: 'file', size: 4, secret: true },
    { name: 'linked.txt', rel: 'linked.txt', kind: 'file', size: 4, hardLink: true },
  ],
  'C:\\Users\\me\\Projects\nsrc': [
    { name: 'lib', rel: 'src/lib', kind: 'dir' },
    { name: 'App.tsx', rel: 'src/App.tsx', kind: 'file', size: 300 },
    { name: 'report.pdf', rel: 'src/report.pdf', kind: 'file', size: 9000 },
  ],
  'C:\\Users\\me\\Projects\nsrc/lib': [{ name: 'util.ts', rel: 'src/lib/util.ts', kind: 'file' }],
}

export interface FakeApiOptions {
  key?: ApiKeyStatus
  grants?: GrantsState
  chat?: ChatState
  provider?: ProviderStatus
  audit?: AuditStatus
  theme?: ThemePreference
  history?: HistoryState
  layout?: LayoutPrefs
  files?: Record<string, FileEntry[]>
}

/** A DesktopApi double: spies for every call, plus `push*` to simulate main's events. */
export function fakeApi(options: FakeApiOptions = {}) {
  const chatListeners = new Set<(event: ChatEvent) => void>()
  const approvalListeners = new Set<(prompt: ApprovalPrompt) => void>()
  const auditListeners = new Set<(status: AuditStatus) => void>()
  const loginListeners = new Set<(state: ProviderLoginState) => void>()
  const filesListeners = new Set<(change: FilesChanged) => void>()
  const files = options.files ?? FAKE_FILES
  let key: ApiKeyStatus = options.key ?? { saved: true, error: null }
  let grants: GrantsState = options.grants ?? {
    roots: ['C:\\Users\\me\\Projects'],
    loadError: null,
  }
  let model: ModelSettings = {
    model: 'claude-sonnet-5-5',
    defaultModel: 'claude-sonnet-5-5',
    options: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    ],
  }
  let theme: ThemePreference = options.theme ?? 'system'
  let layout: LayoutPrefs = options.layout ?? DEFAULT_LAYOUT
  let history: HistoryState = options.history ?? { conversations: [], activeId: null }
  // What main has open; New chat and opening a chat replace it.
  let current: ChatState = { items: [], running: false, loadError: null, ...options.chat }
  const chatState = (): ChatState => ({ ...current, history })
  const subscribe =
    <T>(set: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    }

  let provider: ProviderStatus = options.provider ?? {
    provider: 'anthropic-api',
    state: 'ready',
    message: 'API mode',
  }
  const rootOf = (id: string): string | undefined => grants.roots.find((r) => fakeRootId(r) === id)
  const fileRoots = (): FilesRoot[] =>
    grants.roots.map((root) => ({
      id: fakeRootId(root),
      name: root.split(/[\\/]/).pop() ?? root,
      path: root,
    }))
  const api = {
    files: {
      roots: vi.fn(() => Promise.resolve(fileRoots())),
      list: vi.fn((location: FileLocation) => {
        const root = rootOf(location.rootId)
        const entries = root === undefined ? undefined : files[`${root}\n${location.rel}`]
        return Promise.resolve(
          entries
            ? { ok: true as const, entries, more: 0 }
            : { ok: false as const, reason: 'That folder is no longer granted.' },
        )
      }),
      watch: vi.fn((_locations: FileLocation[]) => Promise.resolve()),
      search: vi.fn((query: string) => {
        const hits: FileSearchHit[] = []
        for (const [key, entries] of Object.entries(files)) {
          const root = key.slice(0, key.indexOf('\n'))
          for (const entry of entries) {
            if (entry.denied || entry.secret || entry.hardLink) continue
            if (entry.kind !== 'file' && entry.kind !== 'dir') continue
            if (!entry.name.toLowerCase().includes(query.toLowerCase())) continue
            hits.push({
              rootId: fakeRootId(root),
              rel: entry.rel,
              name: entry.name,
              kind: entry.kind,
              rootName: root.split('\\').pop() ?? root,
            })
          }
        }
        return Promise.resolve(hits)
      }),
      reveal: vi.fn((_location: FileLocation) => Promise.resolve({ ok: true as const })),
      copyPath: vi.fn((_location: FileLocation) => Promise.resolve({ ok: true as const })),
      reference: vi.fn((location: FileLocation) => {
        const root = rootOf(location.rootId)
        if (root === undefined || location.rel.includes('secret'))
          return Promise.resolve({ ok: false as const, reason: 'Not allowed.' })
        const path = location.rel ? `${root}\\${location.rel.replaceAll('/', '\\')}` : root
        return Promise.resolve({ ok: true as const, text: `@"${path}"` })
      }),
      onChanged: vi.fn(subscribe(filesListeners)),
    },
    provider: {
      models: vi.fn<DesktopApi['provider']['models']>(() =>
        Promise.resolve({
          ok: true,
          value: {
            provider: provider.provider,
            options: [],
            selectedModel: null,
            savedModel: null,
            defaultModel: null,
            resolvedModel: null,
          },
        }),
      ),
      setModel: vi.fn<DesktopApi['provider']['setModel']>(() =>
        Promise.resolve({
          ok: false,
          failure: { code: 'invalid_request', message: 'Not supported.' },
        }),
      ),
      allowance: vi.fn<DesktopApi['provider']['allowance']>(() =>
        Promise.resolve({
          ok: true,
          value: {
            provider: provider.provider,
            plan: null,
            state: 'unknown',
            resetsAt: null,
            windows: [],
            lastError: null,
          },
        }),
      ),
      get: vi.fn(() => Promise.resolve(provider)),
      set: vi.fn((next: ProviderId) => {
        provider = {
          provider: next,
          state: 'signed-out',
          message: 'Sign in with your subscription.',
        }
        return Promise.resolve(provider)
      }),
      login: vi.fn(() => {
        provider = { ...provider, state: 'ready', message: 'Signed in.' }
        return Promise.resolve(provider)
      }),
      cancelLogin: vi.fn(async () => {}),
      loginState: vi.fn(() =>
        Promise.resolve<ProviderLoginState>({
          provider: null,
          active: false,
          url: null,
          result: null,
        }),
      ),
      openLoginUrl: vi.fn(async () => {}),
      copyLoginUrl: vi.fn(async () => {}),
      submitLoginCode: vi.fn((_code: string) =>
        Promise.resolve<{ ok: true } | { ok: false; error: string }>({ ok: true }),
      ),
    },
    getAppInfo: vi.fn(() =>
      Promise.resolve({ name: 'desktop-agent', version: '0.1.0', platform: 'win32' }),
    ),
    apiKey: {
      status: vi.fn(() => Promise.resolve(key)),
      set: vi.fn((_key: string) => {
        key = { saved: true, error: null }
        return Promise.resolve(key)
      }),
      clear: vi.fn(() => {
        key = { saved: false, error: null }
        return Promise.resolve(key)
      }),
    },
    grants: {
      list: vi.fn(() => Promise.resolve(grants)),
      add: vi.fn<DesktopApi['grants']['add']>((..._args: unknown[]) => {
        grants = { ...grants, roots: [...grants.roots, 'D:\\Docs'] }
        return Promise.resolve({ status: 'added', root: 'D:\\Docs', grants })
      }),
      remove: vi.fn((root: string) => {
        grants = { ...grants, roots: grants.roots.filter((r) => r !== root) }
        return Promise.resolve(grants)
      }),
    },
    model: {
      get: vi.fn(() => Promise.resolve(model)),
      set: vi.fn((id: string) => {
        model = { ...model, model: id }
        return Promise.resolve(model)
      }),
    },
    layout: {
      get: vi.fn(() => Promise.resolve(layout)),
      set: vi.fn((next: LayoutPrefs) => {
        layout = next
        return Promise.resolve(layout)
      }),
    },
    theme: {
      get: vi.fn(() => Promise.resolve(theme)),
      set: vi.fn((next: ThemePreference) => {
        theme = next
        return Promise.resolve(theme)
      }),
    },
    chat: {
      load: vi.fn(() => Promise.resolve(chatState())),
      send: vi.fn((_text: string) => Promise.resolve({ ok: true as const })),
      stop: vi.fn(() => Promise.resolve()),
      newChat: vi.fn((): Promise<ChatState> => {
        history = { ...history, activeId: null }
        current = { items: [], running: false, loadError: null }
        return Promise.resolve(chatState())
      }),
      history: vi.fn(() => Promise.resolve(history)),
      open: vi.fn((id: string): Promise<ChatState> => {
        history = { ...history, activeId: id }
        current = { items: [], running: false, loadError: null }
        return Promise.resolve(chatState())
      }),
      rename: vi.fn((id: string, title: string) => {
        history = {
          ...history,
          conversations: history.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
        }
        return Promise.resolve(history)
      }),
      remove: vi.fn((id: string) => {
        // Like main: deleting the open chat leaves a new, empty one open.
        if (history.activeId === id) current = { items: [], running: false, loadError: null }
        history = {
          activeId: history.activeId === id ? null : history.activeId,
          conversations: history.conversations.filter((c) => c.id !== id),
        }
        return Promise.resolve(history)
      }),
    },
    approvals: {
      respond: vi.fn((_id: string, _approved: boolean) => Promise.resolve()),
    },
    audit: {
      reveal: vi.fn(async () => {}),
      status: vi.fn(() =>
        Promise.resolve(options.audit ?? { healthy: true, path: 'C:\\Data\\audit.jsonl' }),
      ),
    },
    onChatEvent: vi.fn(subscribe(chatListeners)),
    onApprovalRequest: vi.fn(subscribe(approvalListeners)),
    onAuditStatus: vi.fn(subscribe(auditListeners)),
    onProviderLoginState: vi.fn(subscribe(loginListeners)),
  } satisfies DesktopApi

  return {
    api,
    pushChat: (event: ChatEvent) => {
      for (const listener of chatListeners) listener(event)
    },
    pushApproval: (prompt: ApprovalPrompt) => {
      for (const listener of approvalListeners) listener(prompt)
    },
    pushAudit: (status: AuditStatus) => {
      for (const listener of auditListeners) listener(status)
    },
    pushFilesChanged: (change: FilesChanged) => {
      for (const listener of filesListeners) listener(change)
    },
    pushLoginState: (state: ProviderLoginState) => {
      for (const listener of loginListeners) listener(state)
    },
    listenerCount: () =>
      chatListeners.size + approvalListeners.size + auditListeners.size + loginListeners.size,
  }
}
