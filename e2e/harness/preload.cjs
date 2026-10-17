// The fake `window.desktopApi` for rendering tests, plus `window.e2e` to push
// main -> renderer events and read back the renderer's approval answers.
const { contextBridge } = require('electron')

const listeners = {
  chat: new Set(),
  approval: new Set(),
  audit: new Set(),
  login: new Set(),
  files: new Set(),
  git: new Set(),
}
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
let stopCalls = 0
let layout = {
  version: 1,
  leftOpen: true,
  leftWidth: 272,
  rightOpen: true,
  rightWidth: 320,
  rightTab: 'files',
}
const layoutSaves = []
const commandRuns = []
const loginCalls = { open: 0, copy: 0, codes: [] }
const savedKeys = new Set(['anthropic-api'])
const keyCalls = []

// The Files tree: one granted folder with every kind of entry the tree draws.
const ROOT = 'C:\\Users\\me\\Projects'
const ROOT_ID = 'r00000000000000a1'
const f = (rel, extra = {}) => ({
  name: rel.split('/').pop(),
  rel,
  kind: 'file',
  size: 1024,
  ...extra,
})
const d = (rel, extra = {}) => ({ name: rel.split('/').pop(), rel, kind: 'dir', ...extra })
let files = {
  '': [
    d('src'),
    d('docs'),
    d('.ssh', { kind: 'other', denied: '".ssh" is blocked (SSH keys).' }),
    { name: 'shared-drive', rel: 'shared-drive', kind: 'link', linkOutside: true },
    {
      name: '.env',
      rel: '.env',
      kind: 'other',
      denied: '".env" is blocked (environment files (.env, .env.*)).',
    },
    f('budget-2026.xlsx'),
    f('kickoff.pptx'),
    f('contract.pdf'),
    f('README.md'),
    f('logo.png'),
    f('demo.mp4'),
    f('backup.zip'),
    f('secrets.json', { secret: true }),
    f('notes.txt'),
  ],
  src: [d('src/components'), f('src/App.tsx'), f('src/main.ts'), f('src/styles.css')],
  docs: [f('docs/plan.docx'), f('docs/brief.md')],
  'src/components': [f('src/components/FileTree.tsx')],
}
const filesCalls = { watch: [], reveal: [], copy: [], reference: [], search: [] }
const filesRoots = () => (rootsGranted ? [{ id: ROOT_ID, name: 'Projects', path: ROOT }] : [])
let rootsGranted = true
// The Git tab: the granted folder is a repository with every kind of change.
const DAY = 86_400_000
const gitRepo = { rootId: ROOT_ID, rel: '', name: 'Projects', path: ROOT, kind: 'repo' }
let git = {
  overview: () => ({
    git: 'found',
    version: '2.47.1.windows.1',
    folders: rootsGranted
      ? [{ rootId: ROOT_ID, name: 'Projects', path: ROOT, repos: [gitRepo] }]
      : [],
  }),
  status: {
    ok: true,
    branch: {
      head: 'feature/git-panel',
      oid: '5e1f0c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f',
      upstream: 'origin/feature/git-panel',
      ahead: 2,
      behind: 1,
    },
    changes: [
      { area: 'staged', status: 'added', path: 'src/git/GitTab.tsx', additions: 182, deletions: 0 },
      {
        area: 'staged',
        status: 'renamed',
        path: 'docs/guide.md',
        oldPath: 'docs/old-guide.md',
        additions: 4,
        deletions: 2,
      },
      { area: 'unstaged', status: 'modified', path: 'src/App.tsx', additions: 3, deletions: 1 },
      { area: 'unstaged', status: 'modified', path: 'budget-2026.xlsx', binary: true },
      { area: 'unstaged', status: 'deleted', path: 'notes.txt', additions: 0, deletions: 12 },
      {
        area: 'unstaged',
        status: 'modified',
        path: '.env',
        hidden: 'A secrets file: its contents stay hidden here.',
      },
      { area: 'untracked', status: 'untracked', path: 'docs/brief.md' },
    ],
    more: 0,
  },
  diff: () => ({
    ok: true,
    kind: 'text',
    redacted: false,
    diff: [
      'diff --git a/src/App.tsx b/src/App.tsx',
      '--- a/src/App.tsx',
      '+++ b/src/App.tsx',
      '@@ -184,7 +184,9 @@ export function App() {',
      '               files: (',
      '                 <FilesTab grants={grants} onGrants={setGrants} />',
      '               ),',
      '-              git: <GitTab />,',
      '+              git: <GitTab grants={grants} />,',
      '+              // Changes, Commits; a Pull request view comes later.',
      '+              // Read-only: nothing here writes to the repository.',
      '             }}',
      '           />',
    ].join('\n'),
  }),
  log: {
    ok: true,
    commits: [
      {
        hash: 'a1',
        short: '5e1f0c2',
        author: 'Nick',
        date: Date.now() - 2 * 3600_000,
        subject: 'Add the Git panel (read-only)',
        merge: false,
      },
      {
        hash: 'a2',
        short: '9b8d7e6',
        author: 'Nick',
        date: Date.now() - DAY,
        subject: 'Merge pull request #24 from feat/files-tree',
        merge: true,
      },
      {
        hash: 'a3',
        short: '3c2d1e0',
        author: 'Robin',
        date: Date.now() - 3 * DAY,
        subject: 'Refuse revealing secret files in main',
        merge: false,
      },
      {
        hash: 'a4',
        short: '7c6d5e4',
        author: 'Robin',
        date: Date.now() - 9 * DAY,
        subject: 'Files tree: watch expanded folders',
        merge: false,
      },
      {
        hash: 'a5',
        short: '1e0f9a8',
        author: 'Ada',
        date: Date.now() - 40 * DAY,
        subject: 'Projects and sessions',
        merge: false,
      },
    ],
    more: true,
  },
}
const gitCalls = { status: [], diff: [], log: [], watch: [], install: 0 }
let allowance = { plan: null, state: 'unknown', resetsAt: null, windows: [], lastError: null }
let codexModels = []
let savedCodexModel = null
let history = { conversations: [], activeId: null }
const historyCalls = { open: [], rename: [], remove: [] }
const chatState = () => ({ items: [], running: false, loadError: null, history })
const pushHistory = () => {
  for (const listener of listeners.chat) listener({ type: 'history_changed', history })
}
// Projects and other providers' organised chats, like main's organizer.
let projects = []
let others = []
const projectCalls = []
let newProjectCount = 0
const projectsState = () => ({ provider: provider.provider, projects, others })
const withField = (chat, key, value) => {
  const next = { ...chat }
  delete next[key]
  if (value !== undefined && value !== null) next[key] = value
  return next
}
const organize = (chat, key, value) => {
  projectCalls.push([key, chat, value])
  if (chat.provider === provider.provider) {
    history = {
      ...history,
      conversations: history.conversations.map((c) =>
        c.id === chat.id ? withField(c, key, value) : c,
      ),
    }
    pushHistory()
  } else {
    others = others.map((c) => (c.id === chat.id ? withField(c, key, value) : c))
  }
  return Promise.resolve(projectsState())
}
// The built-in connections as main's registry lists them (src/shared/connections-fixture.ts).
const runtimeLogin = { authKind: 'runtime-login', reportsUsage: false, needsRuntime: true }
const connections = [
  {
    id: 'claude-subscription',
    vendor: 'anthropic',
    access: 'subscription',
    label: 'Claude · Subscription',
    shortLabel: 'Claude',
    title: 'Claude · Subscription',
    description: 'Sign in with your Claude account. No API key needed.',
    runtimeLabel: 'Claude Code',
    capabilities: { ...runtimeLogin, listsModels: false },
    personalUseOnly: true,
    pickerOrder: 1,
  },
  {
    id: 'codex-subscription',
    vendor: 'openai',
    access: 'subscription',
    label: 'Codex · ChatGPT',
    shortLabel: 'Codex',
    title: 'Codex · ChatGPT',
    description: 'Sign in with your ChatGPT account. No API key needed.',
    runtimeLabel: 'Codex',
    capabilities: { ...runtimeLogin, listsModels: true, reportsUsage: true },
    personalUseOnly: false,
    pickerOrder: 0,
  },
  {
    id: 'anthropic-api',
    vendor: 'anthropic',
    access: 'api-key',
    label: 'Claude · API',
    shortLabel: 'Claude API',
    title: 'Anthropic API',
    description: 'Use your own API key.',
    capabilities: {
      authKind: 'api-key',
      listsModels: false,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 2,
  },
  {
    id: 'openai-api',
    vendor: 'openai',
    access: 'api-key',
    label: 'OpenAI · API',
    shortLabel: 'OpenAI',
    title: 'OpenAI API',
    description: 'Use your own OpenAI API key. Billed by OpenAI.',
    capabilities: {
      authKind: 'api-key',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 3,
  },
  {
    id: 'gemini-api',
    vendor: 'google',
    access: 'api-key',
    label: 'Gemini · API',
    shortLabel: 'Gemini',
    title: 'Gemini API',
    description: 'Use a Gemini API key from Google AI Studio. Free keys work, with limits.',
    capabilities: {
      authKind: 'api-key',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 4,
    notice:
      'Free Gemini API keys share your data with Google. On the Gemini API free tier, Google may use your prompts, files the agent reads and the responses to improve its products, and people may review them. Do not use a free key with confidential or personal information. Paid-tier usage is not used this way.',
  },
  {
    id: 'openrouter-api',
    vendor: 'openrouter',
    access: 'api-key',
    label: 'OpenRouter · API',
    shortLabel: 'OpenRouter',
    title: 'OpenRouter API',
    description: 'Use your own OpenRouter key to reach many models. Billed by OpenRouter.',
    capabilities: {
      authKind: 'api-key',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 5,
  },
  {
    id: 'ollama',
    vendor: 'local',
    access: 'free',
    label: 'Ollama · Local',
    shortLabel: 'Ollama',
    title: 'Ollama',
    description: 'Run open models on this computer with Ollama. Free; nothing leaves your PC.',
    capabilities: {
      authKind: 'local',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 6,
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
  },
  {
    id: 'lmstudio',
    vendor: 'local',
    access: 'free',
    label: 'LM Studio · Local',
    shortLabel: 'LM Studio',
    title: 'LM Studio',
    description: 'Run open models on this computer with LM Studio. Free; nothing leaves your PC.',
    capabilities: {
      authKind: 'local',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 7,
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
  },
]

const model = {
  model: 'claude-sonnet-5-5',
  defaultModel: 'claude-sonnet-5-5',
  options: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }],
}

const modelsResult = () => {
  const options = provider.provider === 'codex-subscription' ? codexModels : []
  return {
    ok: true,
    value: {
      provider: provider.provider,
      options,
      selectedModel: savedCodexModel ?? options[0]?.id ?? null,
      savedModel: savedCodexModel,
      defaultModel: options[0]?.id ?? null,
      resolvedModel: options[0]?.id ?? null,
    },
  }
}

contextBridge.exposeInMainWorld('desktopApi', {
  git: {
    overview: () => Promise.resolve(git.overview()),
    status: (repo) => {
      gitCalls.status.push(repo)
      return Promise.resolve(git.status)
    },
    diff: (request) => {
      gitCalls.diff.push(request)
      return Promise.resolve(git.diff(request))
    },
    log: (request) => {
      gitCalls.log.push(request)
      return Promise.resolve(git.log)
    },
    watch: (repos) => {
      gitCalls.watch.push(repos)
      return Promise.resolve()
    },
    openInstallPage: () => {
      gitCalls.install += 1
      return Promise.resolve()
    },
    onChanged: subscribe(listeners.git),
  },
  files: {
    roots: () => Promise.resolve(filesRoots()),
    list: ({ rootId, rel }) => {
      const entries = rootId === ROOT_ID && rootsGranted ? files[rel] : undefined
      return Promise.resolve(
        entries
          ? { ok: true, entries, more: 0 }
          : { ok: false, reason: 'That folder no longer exists.' },
      )
    },
    watch: (locations) => {
      filesCalls.watch.push(locations)
      return Promise.resolve()
    },
    search: (query) => {
      filesCalls.search.push(query)
      const hits = []
      for (const entries of Object.values(files))
        for (const entry of entries)
          if (
            !entry.denied &&
            !entry.secret &&
            (entry.kind === 'file' || entry.kind === 'dir') &&
            entry.name.toLowerCase().includes(query.toLowerCase())
          )
            hits.push({
              rootId: ROOT_ID,
              rel: entry.rel,
              name: entry.name,
              kind: entry.kind,
              rootName: 'Projects',
            })
      return Promise.resolve(hits.slice(0, 20))
    },
    reveal: (location) => {
      filesCalls.reveal.push(location)
      // Like main: secret files are never revealed.
      if (location.rel.includes('secrets'))
        return Promise.resolve({ ok: false, reason: 'Secret files cannot be opened or revealed.' })
      return Promise.resolve({ ok: true })
    },
    copyPath: (location) => {
      filesCalls.copy.push(location)
      return Promise.resolve({ ok: true })
    },
    reference: (location) => {
      filesCalls.reference.push(location)
      if (location.rel.includes('secrets'))
        return Promise.resolve({ ok: false, reason: 'Not allowed.' })
      const path = location.rel ? `${ROOT}\\${location.rel.replaceAll('/', '\\')}` : ROOT
      return Promise.resolve({ ok: true, text: `@"${path}"` })
    },
    onChanged: subscribe(listeners.files),
  },
  projects: {
    state: () => Promise.resolve(projectsState()),
    create: (name, icon) => {
      newProjectCount += 1
      const project = {
        id: `00000000-0000-4000-8000-${String(newProjectCount).padStart(12, '0')}`,
        name,
        icon,
      }
      projects = [...projects, project]
      projectCalls.push(['create', name, icon])
      return Promise.resolve({ project, state: projectsState() })
    },
    rename: (id, name, icon) => {
      projects = projects.map((p) => (p.id === id ? { ...p, name, icon } : p))
      return Promise.resolve(projectsState())
    },
    remove: (id) => {
      projects = projects.filter((p) => p.id !== id)
      history = {
        ...history,
        conversations: history.conversations.map((c) =>
          c.projectId === id ? withField(c, 'projectId', null) : c,
        ),
      }
      others = others.map((c) => (c.projectId === id ? withField(c, 'projectId', null) : c))
      pushHistory()
      return Promise.resolve(projectsState())
    },
    move: (id, to) => {
      const index = projects.findIndex((p) => p.id === id)
      const project = projects[index]
      const rest = projects.filter((p) => p.id !== id)
      const target =
        to === 'top' ? 0 : to === 'bottom' ? rest.length : index + (to === 'up' ? -1 : 1)
      rest.splice(Math.max(0, Math.min(rest.length, target)), 0, project)
      projects = rest
      return Promise.resolve(projectsState())
    },
  },
  chats: {
    pin: (chat, pinned) => organize(chat, 'pinnedAt', pinned ? Date.now() : null),
    archive: (chat, archived) => organize(chat, 'archivedAt', archived ? Date.now() : null),
    move: (chat, projectId) => organize(chat, 'projectId', projectId),
    fork: (chat, prompts) => {
      projectCalls.push(['fork', chat, prompts])
      const source = history.conversations.find((c) => c.id === chat.id)
      const id = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
      if (source) {
        const now = Date.now()
        const copy = {
          id,
          title: `Fork of ${source.title}`,
          createdAt: now,
          updatedAt: now,
          forkedFrom: { id: chat.id, atMessageIndex: null },
        }
        if (source.projectId) copy.projectId = source.projectId
        history = { ...history, conversations: [copy, ...history.conversations] }
        pushHistory()
      }
      return Promise.resolve({ chat: { provider: chat.provider, id }, state: projectsState() })
    },
    rename: (chat, title) => organize(chat, 'title', title),
    remove: (chat) => {
      others = others.filter((c) => c.id !== chat.id)
      return Promise.resolve(projectsState())
    },
    open: (chat) => {
      projectCalls.push(['open', chat])
      provider = { provider: chat.provider, state: 'ready', message: 'Ready.' }
      return Promise.resolve(provider)
    },
  },
  provider: {
    models: () => Promise.resolve(modelsResult()),
    setModel: (next) => {
      savedCodexModel = next
      return Promise.resolve(modelsResult())
    },
    allowance: () =>
      Promise.resolve({ ok: true, value: { provider: provider.provider, ...allowance } }),
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
  command: {
    run: (command, cwd) => {
      commandRuns.push({ command, cwd })
      return Promise.resolve({ ok: true })
    },
  },
  layout: {
    get: () => Promise.resolve(layout),
    set: (next) => {
      layout = next
      layoutSaves.push(next)
      return Promise.resolve(layout)
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
  // Anthropic API starts with a key; the other API-key connections without one. A key
  // starting "bad" is refused the way main refuses one its pinned host rejects.
  apiKey: {
    status: (connection = 'anthropic-api') =>
      Promise.resolve({ saved: savedKeys.has(connection), error: null }),
    set: (key, connection = 'anthropic-api') => {
      keyCalls.push(connection)
      if (key.startsWith('bad')) {
        const label = connections.find((c) => c.id === connection)?.shortLabel ?? 'The service'
        return Promise.resolve({
          saved: savedKeys.has(connection),
          error: `${label} rejected the API key. Update it in settings.`,
        })
      }
      savedKeys.add(connection)
      return Promise.resolve({ saved: true, error: null })
    },
    clear: (connection = 'anthropic-api') => {
      savedKeys.delete(connection)
      return Promise.resolve({ saved: false, error: null })
    },
  },
  grants: {
    list: () => Promise.resolve({ roots: rootsGranted ? [ROOT] : [], loadError: null }),
    add: resolve({ status: 'cancelled', grants: { roots: [], loadError: null } }),
    remove: resolve({ roots: [], loadError: null }),
  },
  model: { get: resolve(model), set: resolve(model) },
  chat: {
    load: () => Promise.resolve(chatState()),
    send: resolve({ ok: true }),
    stop: () => {
      stopCalls += 1
      return Promise.resolve()
    },
    newChat: () => {
      history = { ...history, activeId: null }
      return Promise.resolve(chatState())
    },
    history: () => Promise.resolve(history),
    open: (id) => {
      historyCalls.open.push(id)
      history = { ...history, activeId: id }
      return Promise.resolve(chatState())
    },
    rename: (id, title) => {
      historyCalls.rename.push([id, title])
      history = {
        ...history,
        conversations: history.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
      }
      return Promise.resolve(history)
    },
    remove: (id) => {
      historyCalls.remove.push(id)
      history = {
        activeId: history.activeId === id ? null : history.activeId,
        conversations: history.conversations.filter((c) => c.id !== id),
      }
      return Promise.resolve(history)
    },
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
  connections: {
    list: () => Promise.resolve(structuredClone(connections)),
    baseUrl: (id) => {
      const connection = connections.find((c) => c.id === id)
      return connection?.defaultBaseUrl
        ? Promise.resolve({ baseUrl: connection.defaultBaseUrl, custom: false, error: null })
        : Promise.reject(new Error('This connection has no address to change.'))
    },
    setBaseUrl: (id, baseUrl) =>
      Promise.resolve({
        baseUrl: baseUrl ?? connections.find((c) => c.id === id)?.defaultBaseUrl ?? '',
        custom: baseUrl !== null,
        error: null,
      }),
  },
  audit: {
    reveal: resolve(undefined),
    status: resolve({ healthy: true, path: 'C:\\Data\\audit.jsonl' }),
  },
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
  // What provider.allowance() answers (without `provider`), and the Codex model list.
  setAllowance: (next) => {
    allowance = next
  },
  setCodexModels: (options) => {
    codexModels = options
  },
  // Set what provider.loginState() answers, and push it like main does.
  pushLoginState: (state) => {
    loginState = state
    for (const listener of listeners.login) listener(state)
  },
  loginCalls: () => ({ ...loginCalls, codes: loginCalls.codes.slice() }),
  // The connection each apiKey.set named, in order.
  keyCalls: () => keyCalls.slice(),
  // Replace the saved chats and push them like main does after a save.
  setHistory: (next) => {
    history = next
    pushHistory()
  },
  historyCalls: () => JSON.parse(JSON.stringify(historyCalls)),
  // Replace the projects and other providers' organised chats (the list reloads on a push).
  setProjects: (next, nextOthers = []) => {
    projects = next
    others = nextOthers
    pushHistory()
  },
  projectCalls: () => JSON.parse(JSON.stringify(projectCalls)),
  // What the renderer saved with layout.set, in order.
  layoutSaves: () => JSON.parse(JSON.stringify(layoutSaves)),
  // What the renderer passed to command.run, in order.
  commandRuns: () => commandRuns.slice(),
  // Change what a folder lists and push the change like main's watcher does.
  setFolder: (rel, entries) => {
    files = { ...files, [rel]: entries }
    for (const listener of listeners.files) listener({ rootId: ROOT_ID, rel })
  },
  filesCalls: () => JSON.parse(JSON.stringify(filesCalls)),
  // The Git tab's answers: 'missing' (no git), 'empty' (a repository with no commits),
  // 'notRepo', or the default repository; then main's change push for it.
  setGit: (state) => {
    if (state === 'missing') git = { ...git, overview: () => ({ git: 'missing' }) }
    if (state === 'notRepo')
      git = {
        ...git,
        overview: () => ({
          git: 'found',
          version: '2.47.1.windows.1',
          folders: [{ rootId: ROOT_ID, name: 'Projects', path: ROOT, repos: [] }],
        }),
      }
    if (state === 'empty')
      git = {
        ...git,
        status: { ok: true, branch: { head: 'main', oid: null }, changes: [], more: 0 },
        log: { ok: true, commits: [], more: false },
      }
  },
  pushGitChanged: (stopped = false) => {
    for (const listener of listeners.git)
      listener({ rootId: ROOT_ID, rel: '', ...(stopped ? { stopped: true } : {}) })
  },
  gitCalls: () => JSON.parse(JSON.stringify(gitCalls)),
  responses: () => responses.slice(),
  stopCalls: () => stopCalls,
  listenerCount: () => listeners.chat.size + listeners.approval.size,
})
