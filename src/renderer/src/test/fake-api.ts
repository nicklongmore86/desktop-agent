import { vi } from 'vitest'
import type {
  ApiKeyStatus,
  ApprovalPrompt,
  AuditStatus,
  ChatEvent,
  ChatState,
  ConversationSummary,
  DesktopApi,
  GrantsState,
  HistoryState,
  ModelSettings,
  ProviderLoginState,
  ProviderStatus,
  SendResult,
  ThemePreference,
} from '../../../shared/ipc'
import {
  type ConnectionBaseUrl,
  type ConnectionVision,
  type ConnectionId,
  type ConnectionInfo,
  type ConnectionsState,
} from '../../../shared/ipc-connections'
import { BUILTIN_CONNECTION_INFO } from '../../../shared/connections-fixture'
import type { AttachOutcome, CopyIntoFolderResult } from '../../../shared/ipc-attachments'
import type {
  FileEntry,
  FileLocation,
  FilesChanged,
  FileSearchHit,
  FilesRoot,
} from '../../../shared/ipc-files'
import type {
  GitChanged,
  GitDiffRequest,
  GitDiffResult,
  GitLogRequest,
  GitLogResult,
  GitOverview,
  GitRepoRef,
  GitStatusResult,
} from '../../../shared/ipc-git'
import { DEFAULT_LAYOUT, type LayoutPrefs } from '../../../shared/ipc-layout'
import type {
  ChatRef,
  Project,
  ProjectIcon,
  ProjectMove,
  ProjectsState,
  ProviderChat,
} from '../../../shared/ipc-projects'

/** A granted folder's fake id: stable per path, not the path. */
export function fakeRootId(root: string): string {
  let hash = 0
  for (const char of root) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `r${hash.toString(16).padStart(16, '0')}`
}

/** The Git tab's fake repository: the granted folder itself, with every kind of change. */
export const FAKE_GIT_STATUS: GitStatusResult = {
  ok: true,
  branch: {
    head: 'main',
    oid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
  },
  changes: [
    { area: 'staged', status: 'added', path: 'src/new.ts', additions: 12, deletions: 0 },
    {
      area: 'staged',
      status: 'renamed',
      path: 'docs/guide.md',
      oldPath: 'docs/old.md',
      additions: 1,
      deletions: 1,
    },
    { area: 'unstaged', status: 'modified', path: 'src/App.tsx', additions: 3, deletions: 1 },
    { area: 'unstaged', status: 'deleted', path: 'old.txt', additions: 0, deletions: 4 },
    {
      area: 'unstaged',
      status: 'modified',
      path: '.env',
      hidden: 'A secrets file: its contents stay hidden here.',
    },
    { area: 'untracked', status: 'untracked', path: 'notes/todo.md' },
  ],
  more: 0,
}

export const FAKE_GIT_LOG: GitLogResult = {
  ok: true,
  commits: [
    {
      hash: 'c1',
      short: 'c1c1c1c',
      author: 'Ada',
      date: Date.UTC(2026, 9, 14),
      subject: 'Add the Git panel',
      merge: false,
    },
    {
      hash: 'c2',
      short: 'c2c2c2c',
      author: 'Bob',
      date: Date.UTC(2026, 9, 1),
      subject: 'Merge branch fix',
      merge: true,
    },
  ],
  more: true,
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

/** What a fresh settings file has set up (the first three; the rest are added in the wizard). */
const DEFAULT_CONFIGURED: readonly ConnectionId[] = [
  'claude-subscription',
  'codex-subscription',
  'anthropic-api',
]

export interface FakeApiOptions {
  /** Anthropic API's key, which the key calls default to. */
  key?: ApiKeyStatus
  /** Other API-key connections' keys, by connection id. */
  keys?: Record<ConnectionId, ApiKeyStatus>
  /** What connections.list() offers; the built-in connections by default. */
  connections?: ConnectionInfo[]
  /** The set-up connections; the built-in ones by default (as in a fresh settings file). */
  configured?: ConnectionId[]
  /** What connections.status() answers for a connection that is not the current one (ready by default). */
  statuses?: Record<ConnectionId, ProviderStatus>
  /** What connections.vision() answers per connection (no vision, offering the setting, by default). */
  vision?: Record<ConnectionId, ConnectionVision>
  showPersonalUse?: boolean
  grants?: GrantsState
  chat?: ChatState
  provider?: ProviderStatus
  audit?: AuditStatus
  theme?: ThemePreference
  history?: HistoryState
  layout?: LayoutPrefs
  files?: Record<string, FileEntry[]>
  projects?: Project[]
  /** Other providers' chats that are pinned or filed. */
  others?: ProviderChat[]
  /** The Git tab's answers; by default one repository (the first granted folder). */
  git?: {
    overview?: GitOverview
    status?: GitStatusResult
    diff?: (request: GitDiffRequest) => GitDiffResult
    log?: GitLogResult
  }
}

const FORK_ID = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
const NEW_PROJECT_ID = 'abababab-abab-4bab-8bab-abababababab'

/** A DesktopApi double: spies for every call, plus `push*` to simulate main's events. */
export function fakeApi(options: FakeApiOptions = {}) {
  const chatListeners = new Set<(event: ChatEvent) => void>()
  const approvalListeners = new Set<(prompt: ApprovalPrompt) => void>()
  const auditListeners = new Set<(status: AuditStatus) => void>()
  const loginListeners = new Set<(state: ProviderLoginState) => void>()
  const filesListeners = new Set<(change: FilesChanged) => void>()
  const gitListeners = new Set<(change: GitChanged) => void>()
  const files = options.files ?? FAKE_FILES
  const keys: Record<ConnectionId, ApiKeyStatus> = {
    'anthropic-api': options.key ?? { saved: true, error: null },
    ...options.keys,
  }
  const keyOf = (connection: ConnectionId = 'anthropic-api'): ApiKeyStatus =>
    keys[connection] ?? { saved: false, error: null }
  const allConnections = options.connections ?? BUILTIN_CONNECTION_INFO
  let configured: ConnectionId[] = options.configured ?? [...DEFAULT_CONFIGURED]
  let showPersonalUse = options.showPersonalUse ?? true
  const visions: Record<ConnectionId, ConnectionVision> = { ...options.vision }
  const visionOf = (id: ConnectionId): ConnectionVision =>
    structuredClone(
      visions[id] ?? { enabled: false, source: 'setting', setting: false, configurable: true },
    )
  const offered = (): ConnectionInfo[] =>
    allConnections.filter((info) => showPersonalUse || !info.personalUseOnly)
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
  const connectionsState = (): ConnectionsState => ({
    configured: configured.filter((id) => offered().some((info) => info.id === id)),
    current: provider.provider,
    showPersonalUse,
  })
  let projects: Project[] = options.projects ?? []
  let others: ProviderChat[] = options.others ?? []
  const projectsState = (): ProjectsState => ({
    provider: provider.provider,
    projects,
    others,
  })
  const pushHistory = (): void => {
    for (const listener of chatListeners) listener({ type: 'history_changed', history })
  }
  /** Changes a chat like main: the open provider's in `history` (and pushes it), others in `others`. */
  const organize = (chat: ChatRef, change: (c: ConversationSummary) => ConversationSummary) => {
    if (chat.provider === provider.provider) {
      if (!history.conversations.some((c) => c.id === chat.id))
        return Promise.reject(new Error('That chat no longer exists.'))
      history = {
        ...history,
        conversations: history.conversations.map((c) => (c.id === chat.id ? change(c) : c)),
      }
      pushHistory()
    } else {
      others = others.map((c) => (c.id === chat.id ? { ...change(c), provider: c.provider } : c))
    }
    return Promise.resolve(projectsState())
  }
  const set =
    <K extends 'pinnedAt' | 'archivedAt' | 'projectId'>(key: K, value: ConversationSummary[K]) =>
    (c: ConversationSummary): ConversationSummary => {
      const next: ConversationSummary = {
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }
      for (const field of ['pinnedAt', 'archivedAt', 'projectId', 'forkedFrom'] as const) {
        const kept = field === key ? value : c[field]
        if (kept !== undefined) Object.assign(next, { [field]: kept })
      }
      return next
    }
  const moveProject = (id: string, to: ProjectMove): void => {
    const index = projects.findIndex((p) => p.id === id)
    const project = projects[index]
    if (!project) return
    const rest = projects.filter((p) => p.id !== id)
    const target = to === 'top' ? 0 : to === 'bottom' ? rest.length : index + (to === 'up' ? -1 : 1)
    rest.splice(Math.max(0, Math.min(rest.length, target)), 0, project)
    projects = rest
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
      // Like main: secret files are never revealed (copying their path is allowed).
      reveal: vi.fn((location: FileLocation) =>
        Promise.resolve(
          location.rel.includes('secret')
            ? { ok: false as const, reason: 'Secret files cannot be opened or revealed.' }
            : { ok: true as const },
        ),
      ),
      copyPath: vi.fn((_location: FileLocation) => Promise.resolve({ ok: true as const })),
      reference: vi.fn((location: FileLocation) => {
        const root = rootOf(location.rootId)
        if (root === undefined || location.rel.includes('secret'))
          return Promise.resolve({ ok: false as const, reason: 'Not allowed.' })
        const path = location.rel ? `${root}\\${location.rel.replaceAll('/', '\\')}` : root
        return Promise.resolve({ ok: true as const, text: `@"${path}"` })
      }),
      onChanged: vi.fn(subscribe(filesListeners)),
      attachDropped: vi.fn((_file: File): Promise<AttachOutcome> =>
        Promise.resolve({ ok: false, code: 'invalid', reason: 'Not a file.' }),
      ),
    },
    attachments: {
      pick: vi.fn((): Promise<AttachOutcome[]> => Promise.resolve([])),
      fromPaste: vi.fn(
        (_bytes: Uint8Array, _mime: string, _name?: string): Promise<AttachOutcome> =>
          Promise.resolve({ ok: false, code: 'binary', reason: 'Not attached.' }),
      ),
      copyIntoFolder: vi.fn((_id: string, _folder: FileLocation): Promise<CopyIntoFolderResult> =>
        Promise.resolve({ ok: false, reason: 'Not copied.' }),
      ),
    },
    git: {
      overview: vi.fn((): Promise<GitOverview> =>
        Promise.resolve(
          options.git?.overview ?? {
            git: 'found',
            version: '2.45.0',
            folders: fileRoots().map((root) => ({
              rootId: root.id,
              name: root.name,
              path: root.path,
              repos: [
                {
                  rootId: root.id,
                  rel: '',
                  name: root.name,
                  path: root.path,
                  kind: 'repo' as const,
                },
              ],
            })),
          },
        ),
      ),
      status: vi.fn((_repo: GitRepoRef) => Promise.resolve(options.git?.status ?? FAKE_GIT_STATUS)),
      diff: vi.fn((request: GitDiffRequest) =>
        Promise.resolve(
          options.git?.diff?.(request) ?? {
            ok: true as const,
            kind: 'text' as const,
            diff: `--- a/${request.path}\n+++ b/${request.path}\n@@ -1 +1 @@\n-old\n+new`,
            redacted: false,
          },
        ),
      ),
      log: vi.fn((_request: GitLogRequest) => Promise.resolve(options.git?.log ?? FAKE_GIT_LOG)),
      watch: vi.fn((_repos: GitRepoRef[]) => Promise.resolve()),
      openInstallPage: vi.fn(() => Promise.resolve()),
      onChanged: vi.fn(subscribe(gitListeners)),
    },
    projects: {
      state: vi.fn(() => Promise.resolve(projectsState())),
      create: vi.fn((name: string, icon: ProjectIcon | null) => {
        const project = { id: NEW_PROJECT_ID, name, icon }
        projects = [...projects, project]
        return Promise.resolve({ project, state: projectsState() })
      }),
      rename: vi.fn((id: string, name: string, icon: ProjectIcon | null) => {
        projects = projects.map((p) => (p.id === id ? { ...p, name, icon } : p))
        return Promise.resolve(projectsState())
      }),
      remove: vi.fn((id: string) => {
        projects = projects.filter((p) => p.id !== id)
        const unfile = (c: ConversationSummary) =>
          c.projectId === id ? set('projectId', undefined)(c) : c
        history = { ...history, conversations: history.conversations.map(unfile) }
        others = others.map((c) => ({ ...unfile(c), provider: c.provider }))
        pushHistory()
        return Promise.resolve(projectsState())
      }),
      move: vi.fn((id: string, to: ProjectMove) => {
        moveProject(id, to)
        return Promise.resolve(projectsState())
      }),
    },
    chats: {
      pin: vi.fn((chat: ChatRef, pinned: boolean) =>
        organize(chat, set('pinnedAt', pinned ? Date.now() : undefined)),
      ),
      archive: vi.fn((chat: ChatRef, archived: boolean) =>
        organize(chat, set('archivedAt', archived ? Date.now() : undefined)),
      ),
      move: vi.fn((chat: ChatRef, projectId: string | null) =>
        organize(chat, set('projectId', projectId ?? undefined)),
      ),
      fork: vi.fn((chat: ChatRef, _prompts: number | null) => {
        const source =
          history.conversations.find((c) => c.id === chat.id) ??
          others.find((c) => c.id === chat.id)
        if (!source) return Promise.reject(new Error('That chat no longer exists.'))
        const copy: ConversationSummary = {
          id: FORK_ID,
          title: `Fork of ${source.title}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          forkedFrom: { id: chat.id, atMessageIndex: null },
        }
        if (chat.provider === provider.provider) {
          history = { ...history, conversations: [copy, ...history.conversations] }
          pushHistory()
        }
        return Promise.resolve({
          chat: { provider: chat.provider, id: FORK_ID },
          state: projectsState(),
        })
      }),
      rename: vi.fn((chat: ChatRef, title: string) => organize(chat, (c) => ({ ...c, title }))),
      remove: vi.fn((chat: ChatRef) => {
        others = others.filter((c) => c.id !== chat.id)
        return Promise.resolve(projectsState())
      }),
      open: vi.fn((chat: ChatRef) => {
        // Like main: switch provider, then that chat is open with the provider's list.
        provider = { provider: chat.provider, state: 'ready', message: 'Ready.' }
        const opened = others.find((c) => c.id === chat.id)
        others = []
        history = {
          activeId: chat.id,
          conversations: opened ? [{ ...opened }] : history.conversations,
        }
        current = { items: [], running: false, loadError: null }
        return Promise.resolve(provider)
      }),
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
      set: vi.fn((next: ConnectionId) => {
        provider = {
          provider: next,
          state: 'signed-out',
          message: 'Sign in with your subscription.',
        }
        if (!configured.includes(next)) configured = [...configured, next]
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
      status: vi.fn((connection?: ConnectionId) => Promise.resolve(keyOf(connection))),
      set: vi.fn((_key: string, connection: ConnectionId = 'anthropic-api') => {
        keys[connection] = { saved: true, error: null }
        return Promise.resolve(keyOf(connection))
      }),
      clear: vi.fn((connection: ConnectionId = 'anthropic-api') => {
        keys[connection] = { saved: false, error: null }
        return Promise.resolve(keyOf(connection))
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
    command: {
      run: vi.fn((_command: string, _cwd: string): Promise<SendResult> =>
        Promise.resolve({ ok: true }),
      ),
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
      send: vi.fn((_text: string, _attachmentIds?: string[]): Promise<SendResult> =>
        Promise.resolve({ ok: true }),
      ),
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
    connections: {
      list: vi.fn(() => Promise.resolve(structuredClone(offered()))),
      state: vi.fn(() => Promise.resolve(connectionsState())),
      status: vi.fn((id: ConnectionId) => {
        if (id === provider.provider) return Promise.resolve(provider)
        // Unless a test says otherwise, the other connections are signed in and ready.
        return Promise.resolve<ProviderStatus>(
          options.statuses?.[id] ?? { provider: id, state: 'ready', message: 'Ready.' },
        )
      }),
      add: vi.fn((id: ConnectionId) => {
        if (!offered().some((info) => info.id === id))
          return Promise.reject(new Error('Unknown provider.'))
        if (!configured.includes(id)) configured = [...configured, id]
        return Promise.resolve(connectionsState())
      }),
      remove: vi.fn((id: ConnectionId) => {
        if (!offered().some((info) => info.id === id))
          return Promise.reject(new Error('Unknown provider.'))
        if (id === provider.provider)
          return Promise.reject(new Error('Switch to another connection before removing this one.'))
        configured = configured.filter((entry) => entry !== id)
        return Promise.resolve(connectionsState())
      }),
      setShowPersonalUse: vi.fn((show: boolean) => {
        const personal = allConnections.find(
          (info) => info.id === provider.provider,
        )?.personalUseOnly
        if (!show && personal)
          return Promise.reject(new Error('Switch to another connection before hiding this one.'))
        showPersonalUse = show
        return Promise.resolve(connectionsState())
      }),
      baseUrl: vi.fn((_id: ConnectionId) =>
        Promise.resolve<ConnectionBaseUrl>({
          baseUrl: 'http://127.0.0.1:11434/v1',
          custom: false,
          error: null,
        }),
      ),
      setBaseUrl: vi.fn((_id: ConnectionId, baseUrl: string | null) =>
        Promise.resolve<ConnectionBaseUrl>({
          baseUrl: baseUrl ?? 'http://127.0.0.1:11434/v1',
          custom: baseUrl !== null,
          error: null,
        }),
      ),
      vision: vi.fn((id: ConnectionId) => Promise.resolve(visionOf(id))),
      setVision: vi.fn((id: ConnectionId, enabled: boolean) => {
        const current = visionOf(id)
        if (!current.configurable) return Promise.reject(new Error('Not offered.'))
        visions[id] =
          current.source === 'setting'
            ? { ...current, enabled, setting: enabled }
            : { ...current, setting: enabled }
        return Promise.resolve(visionOf(id))
      }),
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
    pushGitChanged: (change: GitChanged) => {
      for (const listener of gitListeners) listener(change)
    },
    pushLoginState: (state: ProviderLoginState) => {
      for (const listener of loginListeners) listener(state)
    },
    listenerCount: () =>
      chatListeners.size + approvalListeners.size + auditListeners.size + loginListeners.size,
  }
}
