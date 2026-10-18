import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConnectionId } from './ipc-connections'
import { fakeServer, redirectFetch, type FakeServer } from './llm/openai-compat/test-support'
import { createAnthropicApiAdapter } from './providers/adapters/anthropic-api'
import { chatgptPlanAdapter } from './providers/adapters/chatgpt-plan'
import { startFakeOpenAi, type FakeOpenAi } from './providers/chatgpt-auth/fake-openai'
import { openChatgptAuth } from './providers/chatgpt-auth/service'
import { createAppServices } from './services'

/**
 * The ChatGPT plan connection through the app's services, as the IPC handlers call them:
 * removing it signs out and deletes its tokens but never its chats, and the tokens can
 * never be read through the API-key calls.
 */

let oauth: FakeOpenAi
let api: FakeServer
let userData: string
beforeEach(async () => {
  oauth = await startFakeOpenAi()
  api = await fakeServer()
  userData = await mkdtemp(join(tmpdir(), 'chatgpt-plan-services-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await oauth.close()
  await api.close()
  await rm(userData, { recursive: true, force: true })
})

async function services() {
  return createAppServices({
    userData,
    openUrl: oauth.openUrl,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
      decryptString: (data) => Buffer.from(data.toString().slice(4), 'base64').toString(),
    },
    trash: () => Promise.resolve(),
    emit: vi.fn(),
    promptApproval: vi.fn(),
    onAuditStatus: vi.fn(),
    adapters: [
      createAnthropicApiAdapter,
      chatgptPlanAdapter({
        auth: (host) => {
          if (!host.keys || !host.settings) throw new Error('no stores')
          return openChatgptAuth(
            { keys: host.keys, settings: host.settings, sleep: () => Promise.resolve() },
            oauth.endpoints,
          )
        },
        fetch: redirectFetch(api.origin),
        log: () => {},
      }),
    ],
  })
}

it('removing the connection signs out and deletes its tokens, never its chats', async () => {
  const app = await services()
  await app.provider.set('chatgpt-plan')
  expect(await app.provider.login()).toMatchObject({ state: 'ready', signedIn: true })
  expect(await readdir(join(userData, 'secrets'))).toEqual(['chatgpt-plan.enc'])
  const chats = join(userData, 'history', 'chatgpt-plan')
  await mkdir(chats, { recursive: true })
  await writeFile(join(chats, 'kept.json'), '{"kept":true}')

  // Chats go there, so it cannot be removed, and nothing is signed out.
  await expect(app.connections.remove('chatgpt-plan')).rejects.toThrow(
    'Switch to another connection before removing this one.',
  )
  expect(oauth.revokeRequests).toHaveLength(0)

  await app.provider.set('anthropic-api')
  const state = await app.connections.remove('chatgpt-plan')
  expect(state.configured).not.toContain('chatgpt-plan')
  expect(state).not.toHaveProperty('notice')
  expect(oauth.revokeRequests).toHaveLength(1)
  expect(await readdir(join(userData, 'secrets'))).toEqual([])
  expect(await readFile(join(chats, 'kept.json'), 'utf8')).toBe('{"kept":true}')
  expect(await app.connections.status('chatgpt-plan')).toMatchObject({ state: 'signed-out' })
  // The registration stays for a later sign-in; no token is in settings.json.
  const settings = await readFile(join(userData, 'settings.json'), 'utf8')
  expect(settings).toContain('"hostId"')
  expect(settings).not.toMatch(/token|eyJ/i)
})

it('passes on an unconfirmed sign-out as a notice', async () => {
  const app = await services()
  await app.provider.set('chatgpt-plan')
  await app.provider.login()
  await app.provider.set('anthropic-api')
  oauth.options.revokeReply = () => ({ status: 503 })
  const state = await app.connections.remove('chatgpt-plan')
  expect(state.notice).toMatch(/couldn't confirm sign-out at OpenAI/)
  expect(await readdir(join(userData, 'secrets'))).toEqual([])
})

it('never hands the stored sign-in to the key calls, and still rejects unknown ids', async () => {
  const app = await services()
  await app.provider.set('chatgpt-plan')
  await app.provider.login()
  await expect(app.apiKey.get('chatgpt-plan')).rejects.toThrow('Unknown provider.')
  await expect(app.apiKey.hasKey('chatgpt-plan')).rejects.toThrow('Unknown provider.')
  await expect(app.apiKey.set('x', 'chatgpt-plan')).rejects.toThrow('Unknown provider.')
  await expect(app.apiKey.clear('chatgpt-plan')).rejects.toThrow('Unknown provider.')
  expect(await readdir(join(userData, 'secrets'))).toEqual(['chatgpt-plan.enc'])
  // A built-in id this build did not register, a near miss, and a malformed one.
  for (const id of ['codex-subscription', 'chatgpt-plan-x', 'ChatGPT-Plan', '../secrets'])
    expect(() => parseConnectionId(id, app.connections)).toThrow('Unknown provider.')
  await expect(app.provider.set('codex-subscription')).rejects.toThrow('Unknown provider.')
  expect(parseConnectionId('chatgpt-plan', app.connections)).toBe('chatgpt-plan')
})
