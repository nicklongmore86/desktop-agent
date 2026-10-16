import { vi } from 'vitest'
import type {
  ApiKeyStatus,
  ApprovalPrompt,
  AuditStatus,
  ChatEvent,
  ChatState,
  DesktopApi,
  GrantsState,
  ModelSettings,
  ProviderLoginState,
  ProviderStatus,
  ProviderId,
  ThemePreference,
} from '../../../shared/ipc'

export interface FakeApiOptions {
  key?: ApiKeyStatus
  grants?: GrantsState
  chat?: ChatState
  provider?: ProviderStatus
  audit?: AuditStatus
  theme?: ThemePreference
}

/** A DesktopApi double: spies for every call, plus `push*` to simulate main's events. */
export function fakeApi(options: FakeApiOptions = {}) {
  const chatListeners = new Set<(event: ChatEvent) => void>()
  const approvalListeners = new Set<(prompt: ApprovalPrompt) => void>()
  const auditListeners = new Set<(status: AuditStatus) => void>()
  const loginListeners = new Set<(state: ProviderLoginState) => void>()
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
  const api = {
    provider: {
      models: vi.fn<DesktopApi['provider']['models']>(),
      setModel: vi.fn<DesktopApi['provider']['setModel']>(),
      allowance: vi.fn<DesktopApi['provider']['allowance']>(),
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
      add: vi.fn((..._args: unknown[]) => {
        grants = { ...grants, roots: [...grants.roots, 'D:\\Docs'] }
        return Promise.resolve({ status: 'added' as const, root: 'D:\\Docs', grants })
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
    theme: {
      get: vi.fn(() => Promise.resolve(theme)),
      set: vi.fn((next: ThemePreference) => {
        theme = next
        return Promise.resolve(theme)
      }),
    },
    chat: {
      load: vi.fn(() =>
        Promise.resolve(options.chat ?? { items: [], running: false, loadError: null }),
      ),
      send: vi.fn((_text: string) => Promise.resolve({ ok: true as const })),
      stop: vi.fn(() => Promise.resolve()),
      newChat: vi.fn(() => Promise.resolve({ items: [], running: false, loadError: null })),
    },
    approvals: {
      respond: vi.fn((_id: string, _approved: boolean) => Promise.resolve()),
    },
    audit: {
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
    pushLoginState: (state: ProviderLoginState) => {
      for (const listener of loginListeners) listener(state)
    },
    listenerCount: () =>
      chatListeners.size + approvalListeners.size + auditListeners.size + loginListeners.size,
  }
}
