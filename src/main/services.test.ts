import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createAppServices } from './services'
import { SubscriptionError } from './providers/errors'
import { SubscriptionProviders } from './providers/service'

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
  const invalidate = vi.spyOn(SubscriptionProviders.prototype, 'invalidateMetadata')
  vi.spyOn(SubscriptionProviders.prototype, 'status').mockImplementation((provider) =>
    Promise.resolve({ provider, state: 'ready', message: 'ready' }),
  )
  const subscriptions = vi.spyOn(SubscriptionProviders.prototype, 'runner').mockImplementation(() =>
    Promise.resolve({
      run: (conversation) =>
        Promise.resolve({
          conversation: [...conversation, { role: 'assistant', content: 'subscription reply' }],
          stopReason: 'end_turn',
        }),
    }),
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
  expect(services.settings.provider).toBe('anthropic-api')
  expect(services.settings.model).toBe('claude-opus-5-5')
  expect(services.chat.state().items[0]).toMatchObject({ text: 'legacy API history' })
  expect(await services.chat.send('API attempt')).toMatchObject({ ok: false, code: 'no_api_key' })
  const keyRead = vi
    .spyOn(services.apiKey, 'get')
    .mockRejectedValue(new Error('API key must not be read'))
  for (const provider of ['claude-subscription', 'codex-subscription'] as const) {
    await services.provider.set(provider)
    expect(services.chat.state().items).toEqual([])
    expect(await services.chat.send(provider)).toEqual({ ok: true })
    await services.chat.idle()
  }
  expect(keyRead).not.toHaveBeenCalled()
  expect(subscriptions).toHaveBeenCalledTimes(2)
  await services.provider.set('claude-subscription')
  expect(services.chat.state().items[0]).toMatchObject({ text: 'claude-subscription' })
  await services.provider.set('anthropic-api')
  expect(services.chat.state().items[0]).toMatchObject({ text: 'legacy API history' })
  expect(invalidate).toHaveBeenCalledTimes(4)
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
      .spyOn(SubscriptionProviders.prototype, 'runner')
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
    vi.spyOn(SubscriptionProviders.prototype, method).mockRejectedValue(
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
  vi.spyOn(SubscriptionProviders.prototype, 'models').mockResolvedValue(value)
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
  vi.spyOn(SubscriptionProviders.prototype, 'status').mockImplementation((provider) =>
    Promise.resolve({ provider, state: 'ready', message: 'ready' }),
  )
  vi.spyOn(SubscriptionProviders.prototype, 'runner').mockImplementation(() =>
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
  // Other providers have their own list.
  await services.provider.set('codex-subscription')
  expect(chat.historyState()).toEqual({ conversations: [], activeId: null })
  await services.provider.set('claude-subscription')
  expect(chat.historyState().activeId).toBe(legacy?.id)
  expect(chat.historyState().conversations.map((c) => c.title)).toContain('Renamed')

  await chat.remove(legacy?.id ?? '')
  expect(chat.state().items).toEqual([])
  expect(chat.historyState().conversations.map((c) => c.title)).toEqual(['A brand new question'])
})
