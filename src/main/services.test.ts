import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createAppServices } from './services'
import { SubscriptionError } from './providers/errors'
import { ConnectionService } from './providers/service'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
it('preserves legacy API history and starts both subscriptions without reading the API key', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'provider-services-'))
  dirs.push(userData)
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ version: 1, model: 'claude-opus-5-5' }),
  )
  await writeFile(
    join(userData, 'conversation.json'),
    JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'legacy API history' }] }),
  )
  const invalidate = vi.spyOn(ConnectionService.prototype, 'invalidateMetadata')
  vi.spyOn(ConnectionService.prototype, 'status').mockImplementation((provider) =>
    Promise.resolve({ provider, state: 'ready', message: 'ready' }),
  )
  // The subscriptions get a fake runner; Anthropic API goes through its real adapter.
  const subscriptions = vi
    .spyOn(ConnectionService.prototype, 'runner')
    .mockImplementation(function (this: ConnectionService, provider, tools, signal) {
      if (provider === 'anthropic-api') return this.registry.require(provider).runner(tools, signal)
      return Promise.resolve({
        run: (conversation) =>
          Promise.resolve({
            conversation: [...conversation, { role: 'assistant', content: 'subscription reply' }],
            stopReason: 'end_turn',
          }),
      })
    })
  const decrypt = vi.fn((value: Buffer) => value.toString())
  const services = await createAppServices({
    userData,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: decrypt,
    },
    trash: () => Promise.resolve(),
    emit: vi.fn(),
    promptApproval: vi.fn(),
    onAuditStatus: vi.fn(),
  })
  expect(services.settings.connection).toBe('anthropic-api')
  expect(services.settings.model).toBe('claude-opus-5-5')
  expect(services.chat.state().items[0]).toMatchObject({ text: 'legacy API history' })
  expect(await services.chat.send('API attempt')).toMatchObject({ ok: false, code: 'no_api_key' })
  // A saved API key is never decrypted for a subscription: no fallback to API billing.
  await services.apiKey.set('sk-ant-saved')
  decrypt.mockClear()
  const home = services.chat.openRef
  expect(home?.provider).toBe('anthropic-api')
  for (const provider of ['claude-subscription', 'codex-subscription'] as const) {
    // The open chat continues on the new connection.
    await services.provider.set(provider)
    expect(services.chat.state().items[0]).toMatchObject({ text: 'legacy API history' })
    expect(await services.chat.send(provider)).toEqual({ ok: true })
    await services.chat.idle()
  }
  expect(decrypt).not.toHaveBeenCalled()
  expect(subscriptions).toHaveBeenCalledTimes(3)
  // One chat, still in its home's folder, each reply marked with the connection that wrote it.
  expect(services.chat.openRef).toEqual(home)
  expect(
    services.chat
      .state()
      .items.flatMap((item) => (item.kind === 'assistant' ? [[item.text, item.connection]] : [])),
  ).toEqual([
    ['subscription reply', 'claude-subscription'],
    ['subscription reply', 'codex-subscription'],
  ])
  expect(services.chat.historyState().chats).toEqual([
    expect.objectContaining({ provider: 'anthropic-api', lastConnection: 'codex-subscription' }),
  ])
  await services.provider.set('claude-subscription')
  expect(services.chat.state().items[0]).toMatchObject({ text: 'legacy API history' })
  await services.provider.set('anthropic-api')
  expect(services.chat.state().items[0]).toMatchObject({ text: 'legacy API history' })
  // Each switch, and saving the key (its metadata is cached per key).
  expect(invalidate).toHaveBeenCalledTimes(5)
})

it.each([
  ['Missing runtime: codex', 'runtime_unavailable'],
  ['Sign-in expired.', 'auth_expired'],
  ['This model is not available on your plan', 'plan_not_entitled'],
  ['quota exceeded', 'usage_limit'],
] as const)(
  'preserves setup classification for %s without starting or retrying a run',
  async (message, code) => {
    const userData = await mkdtemp(join(tmpdir(), 'setup-failure-'))
    dirs.push(userData)
    await writeFile(
      join(userData, 'settings.json'),
      JSON.stringify({ version: 2, provider: 'codex-subscription' }),
    )
    const runner = vi
      .spyOn(ConnectionService.prototype, 'runner')
      .mockRejectedValue(new Error(message))
    const services = await createAppServices({
      userData,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text),
        decryptString: (value) => value.toString(),
      },
      trash: () => Promise.resolve(),
      emit: vi.fn(),
      promptApproval: vi.fn(),
      onAuditStatus: vi.fn(),
    })
    expect(await services.chat.send('hello')).toMatchObject({ ok: false, code })
    expect(runner).toHaveBeenCalledOnce()
  },
)

it.each(['models', 'allowance', 'setModel'] as const)(
  'returns serializable metadata failure fields for %s',
  async (method) => {
    const userData = await mkdtemp(join(tmpdir(), 'metadata-result-'))
    dirs.push(userData)
    const reset = new Date(Date.now() + 3600000).toISOString()
    vi.spyOn(ConnectionService.prototype, method).mockRejectedValue(
      new SubscriptionError('usage_limit', 'Safe quota explanation.', reset),
    )
    const services = await createAppServices({
      userData,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text),
        decryptString: (value) => value.toString(),
      },
      trash: () => Promise.resolve(),
      emit: vi.fn(),
      promptApproval: vi.fn(),
      onAuditStatus: vi.fn(),
    })
    const result =
      method === 'setModel'
        ? await services.provider.setModel('gpt-5.6-terra')
        : await services.provider[method]()
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ok: false,
      failure: { code: 'usage_limit', message: 'Safe quota explanation.', resetsAt: reset },
    })
  },
)
it('returns a serializable metadata success value', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'metadata-success-'))
  dirs.push(userData)
  const value = {
    provider: 'codex-subscription' as const,
    options: [],
    selectedModel: null,
    savedModel: null,
    defaultModel: null,
    resolvedModel: null,
  }
  vi.spyOn(ConnectionService.prototype, 'models').mockResolvedValue(value)
  const services = await createAppServices({
    userData,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (value) => value.toString(),
    },
    trash: () => Promise.resolve(),
    emit: vi.fn(),
    promptApproval: vi.fn(),
    onAuditStatus: vi.fn(),
  })
  expect(await services.provider.models()).toEqual({ ok: true, value })
})

it('keeps several chats per provider: migrates, opens, renames and deletes them', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'chat-history-'))
  dirs.push(userData)
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ version: 2, provider: 'claude-subscription' }),
  )
  await writeFile(
    join(userData, 'conversation-claude-subscription.json'),
    JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'legacy subscription' }] }),
  )
  vi.spyOn(ConnectionService.prototype, 'status').mockImplementation((provider) =>
    Promise.resolve({ provider, state: 'ready', message: 'ready' }),
  )
  vi.spyOn(ConnectionService.prototype, 'runner').mockImplementation(() =>
    Promise.resolve({
      run: (conversation) =>
        Promise.resolve({
          conversation: [...conversation, { role: 'assistant', content: 'reply' }],
          stopReason: 'end_turn',
        }),
    }),
  )
  const emit = vi.fn()
  const services = await createAppServices({
    userData,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (value) => value.toString(),
    },
    trash: () => Promise.resolve(),
    emit,
    promptApproval: vi.fn(),
    onAuditStatus: vi.fn(),
  })
  const { chat } = services
  const [legacy] = chat.historyState().conversations
  expect(legacy).toMatchObject({ title: 'legacy subscription' })
  expect(chat.state()).toMatchObject({
    items: [{ text: 'legacy subscription' }],
    history: { activeId: legacy?.id },
  })

  await chat.newChat()
  expect(chat.state().items).toEqual([])
  expect(await chat.send('A brand new question')).toEqual({ ok: true })
  await chat.idle()
  const listed = chat.historyState()
  expect(listed.conversations.map((c) => c.title)).toEqual([
    'A brand new question',
    'legacy subscription',
  ])
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'history_changed' }))

  await chat.open(legacy?.id ?? '')
  expect(chat.state().items[0]).toMatchObject({ text: 'legacy subscription' })
  await chat.rename(legacy?.id ?? '', 'Renamed')
  // Another connection continues the open chat; its own list is empty, the shared one is not.
  await services.provider.set('codex-subscription')
  expect(chat.historyState()).toMatchObject({
    conversations: [],
    activeId: legacy?.id,
    active: { provider: 'claude-subscription', id: legacy?.id },
  })
  expect(chat.historyState().chats?.map((c) => [c.provider, c.title])).toEqual([
    ['claude-subscription', 'A brand new question'],
    ['claude-subscription', 'Renamed'],
  ])
  await services.provider.set('claude-subscription')
  expect(chat.historyState().activeId).toBe(legacy?.id)
  expect(chat.historyState().conversations.map((c) => c.title)).toContain('Renamed')

  await chat.remove(legacy?.id ?? '')
  expect(chat.state().items).toEqual([])
  expect(chat.historyState().conversations.map((c) => c.title)).toEqual(['A brand new question'])
})

it('offers the registry’s connections, and can hide the personal-use one', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'connections-'))
  dirs.push(userData)
  const open = () =>
    createAppServices({
      userData,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text),
        decryptString: (value) => value.toString(),
      },
      trash: () => Promise.resolve(),
      emit: vi.fn(),
      promptApproval: vi.fn(),
      onAuditStatus: vi.fn(),
    })
  vi.spyOn(ConnectionService.prototype, 'status').mockImplementation((provider) =>
    Promise.resolve({ provider, state: 'ready', message: 'ready' }),
  )
  const shown = await open()
  // Every built-in, Claude subscription included; the saved choice is not changed.
  expect(shown.connections.list().map(({ id, label }) => [id, label])).toEqual([
    ['claude-subscription', 'Claude · Subscription'],
    ['codex-subscription', 'Codex · ChatGPT'],
    ['chatgpt-plan', 'ChatGPT · Plan'],
    ['anthropic-api', 'Claude · API'],
    ['openai-api', 'OpenAI · API'],
    ['gemini-api', 'Gemini · API'],
    ['openrouter-api', 'OpenRouter · API'],
    ['ollama', 'Ollama · Local'],
    ['lmstudio', 'LM Studio · Local'],
  ])
  expect(shown.settings.connection).toBe('anthropic-api')
  await shown.provider.set('claude-subscription')
  // Only an API-key connection has a key; the key calls refuse any other.
  await expect(shown.apiKey.hasKey('claude-subscription')).rejects.toThrow('Unknown provider.')
  await expect(shown.apiKey.hasKey('ollama')).rejects.toThrow('Unknown provider.')
  await expect(shown.apiKey.hasKey('not-a-connection')).rejects.toThrow('Unknown provider.')
  expect(await shown.apiKey.hasKey('openai-api')).toBe(false)
  expect(await shown.apiKey.hasKey()).toBe(false)
  // Set-up connections: add and remove persist; chats' connection cannot be removed.
  expect(shown.connections.state()).toMatchObject({ current: 'claude-subscription' })
  await expect(shown.connections.remove('claude-subscription')).rejects.toThrow('Switch to another')
  await shown.connections.remove('codex-subscription')
  expect(shown.connections.state().configured).toEqual(['claude-subscription', 'anthropic-api'])
  await shown.connections.add('codex-subscription')
  await expect(shown.connections.add('not-a-connection')).rejects.toThrow('Unknown provider.')
  await expect(shown.connections.remove('not-a-connection')).rejects.toThrow('Unknown provider.')
  // A newly registered connection can be added and taken out again.
  expect((await shown.connections.add('openai-api')).configured).toContain('openai-api')
  expect((await shown.connections.remove('openai-api')).configured).not.toContain('openai-api')
  // Hiding personal-use connections is refused while chats go to one.
  await expect(shown.connections.setShowPersonalUse(false)).rejects.toThrow('Switch to another')
  await shown.provider.set('anthropic-api')
  expect((await shown.connections.setShowPersonalUse(false)).showPersonalUse).toBe(false)
  expect(shown.connections.state().configured).not.toContain('claude-subscription')
  expect((await shown.connections.status('anthropic-api')).state).toBe('ready')

  // A shared build: the saved personal-use connection falls back to the default.
  const hidden = await open()
  expect(hidden.settings.connection).toBe('anthropic-api')
  expect(hidden.connections.list().map(({ id }) => id)).toEqual([
    'codex-subscription',
    'chatgpt-plan',
    'anthropic-api',
    'openai-api',
    'gemini-api',
    'openrouter-api',
    'ollama',
    'lmstudio',
  ])
  expect(hidden.connections.available('claude-subscription')).toBe(false)
  await expect(hidden.provider.set('claude-subscription')).rejects.toThrow('Unknown provider.')
  await expect(
    hidden.projects.open({
      provider: 'claude-subscription',
      id: '00000000-0000-4000-8000-000000000000',
    }),
  ).rejects.toThrow()
})

it('saves a new connection’s key only after the pinned host accepts it, and never switches', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'key-check-'))
  dirs.push(userData)
  // api.openai.com, served locally: the real adapter, with only the network replaced.
  const hosts: string[] = []
  const paths: string[] = []
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    hosts.push(url.origin)
    paths.push(url.pathname)
    const auth = new Headers(init?.headers).get('authorization')
    const ok = auth === 'Bearer sk-good'
    return Promise.resolve(
      new Response(JSON.stringify(ok ? { data: [{ id: 'gpt-5.1' }] } : { error: {} }), {
        status: ok ? 200 : 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  try {
    const services = await createAppServices({
      userData,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text),
        decryptString: (value) => value.toString(),
      },
      trash: () => Promise.resolve(),
      emit: vi.fn(),
      promptApproval: vi.fn(),
      onAuditStatus: vi.fn(),
    })
    await expect(services.apiKey.set('sk-bad', 'openai-api')).rejects.toThrow(
      'OpenAI rejected the API key. Update it in settings.',
    )
    expect(await services.apiKey.hasKey('openai-api')).toBe(false)
    await services.apiKey.set('sk-good', 'openai-api')
    expect(await services.apiKey.hasKey('openai-api')).toBe(true)
    // Its own file; Anthropic's key is untouched.
    expect(await services.apiKey.hasKey()).toBe(false)
    expect(hosts.every((host) => host === 'https://api.openai.com')).toBe(true)
    expect(paths).toEqual(['/v1/models', '/v1/models'])
    expect(services.settings.connection).toBe('anthropic-api')
  } finally {
    vi.stubGlobal('fetch', realFetch)
    vi.unstubAllGlobals()
  }
})

it('lists every registered connection’s chats as one list and continues any of them on the current connection', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'unified-history-'))
  dirs.push(userData)
  const HIDDEN = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  const REMOVED = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'
  const FUTURE = '2c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f'
  const SECRET = 'sk-ant-api03-unified-history-secret'
  // Chats as earlier builds left them (format-2 index, no provenance): one on the hidden
  // personal-use connection, one on a connection the user removed, one in a folder of a
  // connection this build does not register.
  const seed = async (home: string, id: string, text: string) => {
    await mkdir(join(userData, 'history', home), { recursive: true })
    await writeFile(
      join(userData, 'history', home, `${id}.json`),
      JSON.stringify({ version: 1, messages: [{ role: 'user', content: text }] }),
    )
    await writeFile(
      join(userData, 'history', home, 'index.json'),
      JSON.stringify({
        version: 1,
        format: 2,
        activeId: id,
        conversations: [{ id, title: text, createdAt: 1, updatedAt: 2 }],
      }),
    )
  }
  await seed('claude-subscription', HIDDEN, 'hidden chat')
  await seed('codex-subscription', REMOVED, 'removed chat')
  await seed('future-connection', FUTURE, 'future chat')
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 3,
      model: 'claude-opus-5-5',
      connection: 'anthropic-api',
      connectionModels: {},
      connections: [{ id: 'anthropic-api' }],
      showPersonalUseConnections: false,
    }),
  )
  vi.spyOn(ConnectionService.prototype, 'status').mockImplementation((provider) =>
    Promise.resolve({ provider, state: 'ready', message: 'ready' }),
  )
  vi.spyOn(ConnectionService.prototype, 'validateKey').mockResolvedValue(null)
  const runner = vi.spyOn(ConnectionService.prototype, 'runner').mockImplementation((provider) =>
    Promise.resolve({
      model: 'claude-opus-5-5',
      run: (conversation) =>
        Promise.resolve({
          conversation: [...conversation, { role: 'assistant', content: `reply via ${provider}` }],
          stopReason: 'end_turn',
        }),
    }),
  )
  const open = () =>
    createAppServices({
      userData,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text),
        decryptString: (value) => value.toString(),
      },
      trash: () => Promise.resolve(),
      emit: vi.fn(),
      promptApproval: vi.fn(),
      onAuditStatus: vi.fn(),
    })
  const services = await open()
  await services.apiKey.set(SECRET)
  const { chat } = services
  expect(
    chat
      .historyState()
      .chats?.map((c) => [c.provider, c.id])
      .sort(),
  ).toEqual(
    [
      ['claude-subscription', HIDDEN],
      ['codex-subscription', REMOVED],
    ].sort(),
  )

  // Opening the hidden connection's chat continues it on Anthropic API: no switch.
  const status = await services.projects.open({ provider: 'claude-subscription', id: HIDDEN })
  expect(status.provider).toBe('anthropic-api')
  expect(services.settings.connection).toBe('anthropic-api')
  expect(chat.state().items[0]).toMatchObject({ text: 'hidden chat' })
  expect(await chat.send('continue here')).toEqual({ ok: true })
  await chat.idle()
  expect(runner).toHaveBeenLastCalledWith('anthropic-api', expect.anything(), expect.anything())
  const home = join(userData, 'history', 'claude-subscription')
  const saved = JSON.parse(await readFile(join(home, `${HIDDEN}.json`), 'utf8')) as unknown
  expect(saved).toEqual({
    version: 1,
    messages: [
      { role: 'user', content: 'hidden chat' },
      { role: 'user', content: 'continue here' },
      { role: 'assistant', content: 'reply via anthropic-api' },
    ],
    origin: [{ fromIndex: 2, connection: 'anthropic-api', model: 'claude-opus-5-5' }],
  })
  const index = JSON.parse(await readFile(join(home, 'index.json'), 'utf8')) as {
    format: number
    activeId: string
    conversations: { id: string; lastConnection?: string }[]
  }
  expect(index).toMatchObject({
    format: 3,
    activeId: HIDDEN,
    conversations: [{ id: HIDDEN, lastConnection: 'anthropic-api' }],
  })
  expect(services.settings.activeChat).toEqual({ provider: 'claude-subscription', id: HIDDEN })

  // A restart reopens it, across connections.
  const restarted = await open()
  expect(restarted.chat.openRef).toEqual({ provider: 'claude-subscription', id: HIDDEN })
  expect(restarted.chat.state().items.at(-1)).toMatchObject({
    kind: 'assistant',
    connection: 'anthropic-api',
    model: 'claude-opus-5-5',
  })

  // No secret ever reaches the history folders.
  const files = await readdir(join(userData, 'history'), { recursive: true, withFileTypes: true })
  const texts = await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  )
  expect(texts.length).toBeGreaterThan(0)
  for (const text of texts) expect(text).not.toContain(SECRET)
  expect(await readFile(join(userData, 'settings.json'), 'utf8')).not.toContain(SECRET)
})

it('refuses to send a local chat to a cloud connection until the user confirms, across restarts', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'cross-vendor-'))
  dirs.push(userData)
  const ID = '4d5e6f7a-8b9c-4dae-8f0a-3b4c5d6e7f8a'
  const home = join(userData, 'history', 'ollama')
  await mkdir(home, { recursive: true })
  // A chat answered by Ollama, with a file the agent read on this computer.
  await writeFile(
    join(home, `${ID}.json`),
    JSON.stringify({
      version: 1,
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'LOCAL ONLY' }],
        },
        { role: 'assistant', content: 'done' },
      ],
      origin: [{ fromIndex: 1, connection: 'ollama', model: 'llama3' }],
    }),
  )
  await writeFile(
    join(home, 'index.json'),
    JSON.stringify({
      version: 1,
      format: 3,
      activeId: ID,
      conversations: [{ id: ID, title: 'read it', createdAt: 1, updatedAt: 2 }],
    }),
  )
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 3,
      model: 'claude-opus-5-5',
      connection: 'anthropic-api',
      connectionModels: {},
      connections: [{ id: 'anthropic-api' }, { id: 'ollama' }],
      showPersonalUseConnections: false,
      activeChat: { provider: 'ollama', id: ID },
    }),
  )
  const sent: unknown[] = []
  const runner = vi.spyOn(ConnectionService.prototype, 'runner').mockImplementation(() =>
    Promise.resolve({
      model: 'claude-opus-5-5',
      run: (conversation) => {
        sent.push(conversation)
        return Promise.resolve({
          conversation: [...conversation, { role: 'assistant', content: 'cloud reply' }],
          stopReason: 'end_turn',
        })
      },
    }),
  )
  const open = () =>
    createAppServices({
      userData,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text),
        decryptString: (value) => value.toString(),
      },
      trash: () => Promise.resolve(),
      emit: vi.fn(),
      promptApproval: vi.fn(),
      onAuditStatus: vi.fn(),
    })
  const services = await open()
  expect(services.chat.openRef).toEqual({ provider: 'ollama', id: ID })
  const result = await services.chat.send('now in the cloud')
  expect(result).toMatchObject({
    ok: false,
    code: 'confirmation_required',
    sharing: {
      connection: 'anthropic-api',
      destination: 'Claude · API',
      reasons: ['local-to-cloud'],
      sources: [expect.stringContaining('Ollama')],
      includes: { messages: 4, toolOutput: true, attachments: 0 },
    },
  })
  expect(runner).not.toHaveBeenCalled()
  const id = result.ok ? '' : (result.sharing?.id ?? '')
  expect(await services.chat.confirmSharing(id)).toEqual({ ok: true })
  expect(await services.chat.send('now in the cloud')).toEqual({ ok: true })
  await services.chat.idle()
  expect(JSON.stringify(sent)).toContain('LOCAL ONLY')

  // Restarted: the saved confirmation still holds.
  const restarted = await open()
  expect(await restarted.chat.send('and again')).toEqual({ ok: true })
  await restarted.chat.idle()
  expect(runner).toHaveBeenCalledTimes(2)
})
