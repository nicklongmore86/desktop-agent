// The fake `window.desktopApi` for rendering tests, plus `window.e2e` to push
// main -> renderer events and read back the renderer's approval answers.
const { contextBridge } = require('electron')

const listeners = { chat: new Set(), approval: new Set(), audit: new Set(), login: new Set() }
const responses = []
const subscribe = (set) => (listener) => {
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}
const resolve = (value) => () => Promise.resolve(value)
let provider = { provider: 'anthropic-api', state: 'ready', message: 'API mode' }
let loginState = { provider: null, active: false, url: null, result: null }
let theme = 'system'
const loginCalls = { open: 0, copy: 0, codes: [] }
const chatState = { items: [], running: false, loadError: null }
const model = {
  model: 'claude-sonnet-5-5',
  defaultModel: 'claude-sonnet-5-5',
  options: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }],
}

contextBridge.exposeInMainWorld('desktopApi', {
  provider: {
    get: () => Promise.resolve(provider),
    set: (next) => {
      provider = { provider: next, state: 'ready', message: 'Ready.' }
      return Promise.resolve(provider)
    },
    login: () => Promise.resolve(provider),
    cancelLogin: resolve(undefined),
    loginState: () => Promise.resolve(loginState),
    openLoginUrl: () => {
      loginCalls.open += 1
      return Promise.resolve()
    },
    copyLoginUrl: () => {
      loginCalls.copy += 1
      return Promise.resolve()
    },
    submitLoginCode: (code) => {
      loginCalls.codes.push(code)
      return Promise.resolve({ ok: true })
    },
  },
  theme: {
    get: () => Promise.resolve(theme),
    set: (next) => {
      theme = next
      return Promise.resolve(theme)
    },
  },
  getAppInfo: resolve({ name: 'desktop-agent', version: '0.0.0-e2e', platform: process.platform }),
  apiKey: {
    status: resolve({ saved: true, error: null }),
    set: resolve({ saved: true, error: null }),
    clear: resolve({ saved: false, error: null }),
  },
  grants: {
    list: resolve({ roots: ['C:\\Users\\me\\Projects'], loadError: null }),
    add: resolve({ status: 'cancelled', grants: { roots: [], loadError: null } }),
    remove: resolve({ roots: [], loadError: null }),
  },
  model: { get: resolve(model), set: resolve(model) },
  chat: {
    load: resolve(chatState),
    send: resolve({ ok: true }),
    stop: resolve(undefined),
    newChat: resolve(chatState),
  },
  approvals: {
    respond: (id, approved) => {
      responses.push({ id, approved })
      // Like real IPC, the closing event arrives in a later task, after the answer resolves.
      setTimeout(() => {
        for (const listener of listeners.chat) {
          listener({ type: 'approval_closed', approvalId: id, approved })
        }
      }, 0)
      return Promise.resolve()
    },
  },
  audit: { status: resolve({ healthy: true, path: 'C:\\Data\\audit.jsonl' }) },
  onChatEvent: subscribe(listeners.chat),
  onApprovalRequest: subscribe(listeners.approval),
  onAuditStatus: subscribe(listeners.audit),
  onProviderLoginState: subscribe(listeners.login),
})

contextBridge.exposeInMainWorld('e2e', {
  pushApproval: (prompt) => {
    for (const listener of listeners.approval) listener(prompt)
  },
  pushChat: (event) => {
    for (const listener of listeners.chat) listener(event)
  },
  // Choose the provider the app reports (before or after it has loaded).
  setProvider: (next) => {
    provider = next
  },
  // Set what provider.loginState() answers, and push it like main does.
  pushLoginState: (state) => {
    loginState = state
    for (const listener of listeners.login) listener(state)
  },
  loginCalls: () => ({ ...loginCalls, codes: loginCalls.codes.slice() }),
  responses: () => responses.slice(),
  listenerCount: () => listeners.chat.size + listeners.approval.size,
})
