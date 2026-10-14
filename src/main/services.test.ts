import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createAppServices } from './services'
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
})
