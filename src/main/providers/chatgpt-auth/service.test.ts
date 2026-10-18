import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKeyStore, type SafeStorage } from '../../secrets'
import { openSettingsStore, type SettingsStore } from '../../storage/settings-store'
import { startCallbackListener } from './callback-server'
import { PRODUCTION } from './config'
import { ChatgptAuthError, redact } from './errors'
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai'
import { openChatgptAuth, UNCONFIRMED_SIGN_OUT, type ChatgptAuth } from './service'

/** Reversible but not plain text, so the tests can see nothing is saved unencrypted. */
const safeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
  decryptString: (data) => {
    const text = data.toString()
    if (!text.startsWith('enc:')) throw new Error('bad')
    return Buffer.from(text.slice(4), 'base64').toString()
  },
}

let fake: FakeOpenAi
let dir: string
let settings: SettingsStore
let logs: string[]
let clock: number
/** Every error any test saw, so the last test can check none held a secret. */
const seenErrors: unknown[] = []
const seenSecrets = new Set<string>()

beforeEach(async () => {
  fake = await startFakeOpenAi()
  dir = await mkdtemp(join(tmpdir(), 'chatgpt-auth-'))
  settings = await openSettingsStore(join(dir, 'settings.json'))
  logs = []
  clock = Date.now()
})
afterEach(async () => {
  await fake.close()
  await rm(dir, { recursive: true, force: true })
})

function service(overrides: { loginTimeout?: number } = {}): ChatgptAuth {
  return openChatgptAuth(
    {
      keys: createKeyStore({ userDataPath: dir, safeStorage }),
      settings,
      log: (line) => logs.push(line),
      now: () => clock,
      sleep: () => Promise.resolve(),
      ...overrides,
    },
    fake.endpoints,
  )
}

const session = (extra: Partial<Parameters<ChatgptAuth['login']>[0]> = {}) => ({
  signal: new AbortController().signal,
  openUrl: fake.openUrl,
  ...extra,
})

async function failure(promise: Promise<unknown>): Promise<ChatgptAuthError> {
  try {
    await promise
  } catch (error) {
    seenErrors.push(error)
    if (error instanceof ChatgptAuthError) return error
    throw error
  }
  throw new Error('expected a failure')
}

async function savedRecord(): Promise<Record<string, unknown> | null> {
  try {
    const data = await readFile(join(dir, 'secrets', 'chatgpt-plan.enc'))
    return JSON.parse(safeStorage.decryptString(data)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Collects every token the fake issued, for the no-leak checks. */
function noteSecrets() {
  for (const form of fake.tokenRequests)
    for (const key of ['code', 'code_verifier', 'refresh_token'])
      if (form.get(key)) seenSecrets.add(form.get(key) as string)
  const current = fake.currentRefreshToken()
  if (current) seenSecrets.add(current)
}

async function signedIn(auth = service()): Promise<ChatgptAuth> {
  await auth.login(session())
  return auth
}

const portOf = (uri: string) => Number(new URL(uri).port)
const connect = (port: number, host = '127.0.0.1'): Promise<number | string> =>
  new Promise((resolve) => {
    const req = request({ host, port, path: '/auth/callback?x=1', method: 'GET' }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? 'error')
    })
    req.end()
  })

describe('first sign-in (dynamic registration)', () => {
  it('registers with PKCE and OIDC, saves the issued client id, and stores tokens encrypted', async () => {
    let listening: number | string | undefined
    const auth = service()
    const status = await auth.login(
      session({
        openUrl: async (url) => {
          // The listener is already up when the browser is opened.
          listening = await fetch(
            new URL('/other', new URL(url).searchParams.get('redirect_uri') ?? '').href,
          ).then((r) => r.status)
          await fake.openUrl(url)
        },
      }),
    )
    expect(listening).toBe(404)
    expect(status).toEqual({ state: 'signed-in', email: 'person@example.com' })

    const [authorize] = fake.authorizeRequests
    expect(Object.fromEntries(authorize ?? [])).toMatchObject({
      response_type: 'code',
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Desktop Agent',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256',
    })
    expect(authorize?.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(authorize?.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    for (const key of ['state', 'nonce', 'code_challenge'])
      expect(authorize?.get(key)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(authorize?.has('id_token_hint')).toBe(false)

    const [exchange] = fake.tokenRequests
    expect(exchange?.get('client_id')).toBe('oaiapp_test_client')
    expect(exchange?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(exchange?.get('redirect_uri')).toBe(authorize?.get('redirect_uri'))
    expect(exchange?.get('resource')).toBe('https://api.openai.com/v1')
    expect(exchange?.has('client_secret')).toBe(false)

    expect(settings.chatgptAuth).toEqual({
      hostId: authorize?.get('ext_agent_host_id'),
      accounts: [{ subject: 'user-subject-1', clientId: 'oaiapp_test_client' }],
      current: 'user-subject-1',
    })
    const raw = await readFile(join(dir, 'secrets', 'chatgpt-plan.enc'), 'utf8')
    expect(raw).not.toContain(fake.currentRefreshToken())
    expect(await savedRecord()).toMatchObject({
      clientId: 'oaiapp_test_client',
      subject: 'user-subject-1',
      tokens: { refreshToken: fake.currentRefreshToken(), tokenType: 'Bearer' },
    })
    // No refresh while the token is fresh.
    expect(await auth.getAccessToken()).toMatch(/^eyJ/)
    expect(fake.tokenRequests).toHaveLength(1)
    noteSecrets()
  })

  it('signs in again with the saved client id, the same host id and fresh PKCE values', async () => {
    const auth = await signedIn()
    await auth.login(session())
    const [first, second] = fake.authorizeRequests
    expect(second?.get('client_id')).toBe('oaiapp_test_client')
    expect(second?.has('agent_name_hint')).toBe(false)
    expect(second?.get('ext_agent_host_id')).toBe(first?.get('ext_agent_host_id'))
    expect(second?.get('login_hint')).toBe('person@example.com')
    expect(second?.has('id_token_hint')).toBe(false)
    for (const key of ['state', 'nonce', 'code_challenge'])
      expect(second?.get(key)).not.toBe(first?.get(key))
    expect(fake.tokenRequests[1]?.get('client_id')).toBe('oaiapp_test_client')
    noteSecrets()
  })

  it('never puts token material in the authorize URL', async () => {
    const urls: string[] = []
    const auth = service()
    const record = (url: string) => {
      urls.push(url)
      return fake.openUrl(url)
    }
    await auth.login(session({ openUrl: record }))
    clock = Date.now() + 56 * 60 * 1000
    await auth.getAccessToken()
    clock = Date.now()
    await auth.login(session({ openUrl: record }))
    expect(urls).toHaveLength(2)
    noteSecrets()
    const tokens = [...seenSecrets, ...fake.issuedIdTokens]
    expect(tokens.length).toBeGreaterThan(3)
    for (const url of urls) {
      const decoded = decodeURIComponent(url)
      for (const token of tokens) expect(decoded).not.toContain(token)
      expect(decoded).not.toMatch(/eyJ[\w-]*\.[\w-]*/)
      expect(decoded).not.toMatch(/id_token|access_token|refresh_token|code_verifier/)
    }
    // Nor is an ID token kept once it has been verified.
    const saved = JSON.stringify(await savedRecord())
    for (const idToken of fake.issuedIdTokens) expect(saved).not.toContain(idToken)
  })

  it('asks for consent again when requested', async () => {
    await service().login(session({ reconsent: true }))
    expect(fake.authorizeRequests[0]?.get('prompt')).toBe('consent')
  })

  it('allows one sign-in at a time', async () => {
    const auth = service()
    let release: () => void = () => {}
    let opened: () => void = () => {}
    const browserOpened = new Promise<void>((resolve) => (opened = resolve))
    const first = auth.login(
      session({
        openUrl: async (url) => {
          const wait = new Promise<void>((resolve) => (release = resolve))
          opened()
          await wait
          await fake.openUrl(url)
        },
      }),
    )
    await browserOpened
    expect((await failure(auth.login(session()))).code).toBe('busy')
    await expect.poll(async () => (await auth.status()).state).toBe('signing-in')
    release()
    await first
  })
})

describe('callback validation', () => {
  it('rejects a state that does not match, without exchanging the code', async () => {
    fake.options.callback = (query) => {
      query.set('state', 'forged')
    }
    const auth = service()
    expect((await failure(auth.login(session()))).code).toBe('state-mismatch')
    expect(fake.tokenRequests).toHaveLength(0)
    expect(await auth.status()).toEqual({ state: 'signed-out' })
  })

  it('stops on access_denied without exchanging a code', async () => {
    fake.options.callback = (query) => {
      query.delete('code')
      query.delete('client_id')
      query.set('error', 'access_denied')
    }
    expect((await failure(service().login(session()))).code).toBe('access-denied')
    expect(fake.tokenRequests).toHaveLength(0)
  })

  it('treats a registration without an issued client id as incomplete', async () => {
    fake.options.callback = (query) => {
      query.delete('client_id')
    }
    expect((await failure(service().login(session()))).code).toBe('invalid-callback')
    fake.options.callback = (query) => {
      query.set('client_id', 'dynamic_agent_client')
    }
    expect((await failure(service().login(session()))).code).toBe('invalid-callback')
    expect(fake.tokenRequests).toHaveLength(0)
  })

  it('refuses a reauthorization callback that names a different client', async () => {
    const auth = await signedIn()
    fake.options.callback = (query) => {
      query.set('client_id', 'oaiapp_someone_else')
    }
    expect((await failure(auth.login(session()))).code).toBe('invalid-callback')
    expect(settings.chatgptAuth?.accounts).toEqual([
      { subject: 'user-subject-1', clientId: 'oaiapp_test_client' },
    ])
  })

  it('refuses a reauthorization that signs in a different account', async () => {
    const auth = await signedIn()
    const before = await savedRecord()
    fake.options.subject = 'user-subject-2'
    expect((await failure(auth.login(session()))).code).toBe('account-mismatch')
    expect(await savedRecord()).toEqual(before)
    noteSecrets()
  })

  it('refuses to proceed without chatgpt.tokens.use.direct, but keeps the registration', async () => {
    fake.options.scope = 'email offline_access openid profile resource.invoke'
    const auth = service()
    expect((await failure(auth.login(session()))).code).toBe('plan-not-enabled')
    expect(await savedRecord()).toBeNull()
    expect(await auth.status()).toEqual({ state: 'signed-out' })
    expect(settings.chatgptAuth?.accounts).toHaveLength(1)
    // The unusable session is ended at OpenAI.
    await expect.poll(() => fake.revokeRequests.length).toBe(1)
    noteSecrets()
  })
})

describe('ID token validation', () => {
  const cases: [string, (claims: Record<string, unknown>) => Record<string, unknown>][] = [
    ['nonce', (claims) => ({ ...claims, nonce: 'other' })],
    ['missing nonce', ({ nonce: _nonce, ...claims }) => claims],
    ['audience', (claims) => ({ ...claims, aud: 'oaiapp_other' })],
    ['issuer', (claims) => ({ ...claims, iss: 'https://evil.example' })],
    ['expiry', (claims) => ({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 })],
    ['issued in the future', (claims) => ({ ...claims, iat: Math.floor(Date.now() / 1000) + 600 })],
    ['subject', ({ sub: _sub, ...claims }) => claims],
    [
      'several audiences without azp',
      (claims) => ({ ...claims, aud: ['oaiapp_test_client', 'other'] }),
    ],
  ]
  it.each(cases)('rejects a bad %s', async (_name, change) => {
    fake.options.idToken = change
    const auth = service()
    expect((await failure(auth.login(session()))).code).toBe('invalid-id-token')
    expect(await savedRecord()).toBeNull()
    noteSecrets()
  })

  it('rejects a token signed by another key', async () => {
    fake.options.signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    expect((await failure(service().login(session()))).code).toBe('invalid-id-token')
    expect(await savedRecord()).toBeNull()
  })

  it.each([
    ['alg none', (token: string) => forge(token, { alg: 'none', kid: 'test-key' }, '')],
    ['HS256', (token: string) => forge(token, { alg: 'HS256', kid: 'test-key' })],
    ['an unknown key id', (token: string) => forge(token, { alg: 'RS256', kid: 'other' })],
    ['a stripped signature', (token: string) => token.replace(/\.[^.]*$/, '.')],
    ['a tampered payload', (token: string) => tamper(token)],
  ])('rejects %s', async (_name, change) => {
    fake.options.rawIdToken = change
    expect((await failure(service().login(session()))).code).toBe('invalid-id-token')
    expect(await savedRecord()).toBeNull()
  })
})

/** The same token with another header (and, unless given, its original signature). */
function forge(token: string, header: Record<string, unknown>, signature?: string): string {
  const [, payload = '', original = ''] = token.split('.')
  const encoded = Buffer.from(JSON.stringify(header)).toString('base64url')
  return `${encoded}.${payload}.${signature ?? original}`
}
function tamper(token: string): string {
  const [header = '', payload = '', signature = ''] = token.split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
  const changed = Buffer.from(JSON.stringify({ ...claims, sub: 'someone-else' })).toString(
    'base64url',
  )
  return `${header}.${changed}.${signature}`
}

describe('refresh', () => {
  const nearExpiry = () => {
    clock = Date.now() + 56 * 60 * 1000
  }

  it('refreshes near expiry with the issued client id and resource, omitting scope', async () => {
    const auth = await signedIn()
    const first = await auth.getAccessToken()
    nearExpiry()
    const second = await auth.getAccessToken()
    expect(second).not.toBe(first)
    const form = fake.tokenRequests[1]
    expect(form?.get('grant_type')).toBe('refresh_token')
    expect(form?.get('client_id')).toBe('oaiapp_test_client')
    expect(form?.get('resource')).toBe('https://api.openai.com/v1')
    expect(form?.has('scope')).toBe(false)
    noteSecrets()
  })

  it('sends one refresh for concurrent callers', async () => {
    const auth = await signedIn()
    nearExpiry()
    const tokens = await Promise.all(Array.from({ length: 5 }, () => auth.getAccessToken()))
    expect(new Set(tokens).size).toBe(1)
    expect(fake.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token')).toHaveLength(
      1,
    )
    noteSecrets()
  })

  it('persists the rotated refresh token with the rest of the token set', async () => {
    const auth = await signedIn()
    nearExpiry()
    const refreshed = await auth.getAccessToken()
    const record = await savedRecord()
    expect(record).toMatchObject({
      tokens: { accessToken: refreshed, refreshToken: fake.currentRefreshToken() },
    })
    // A restarted app uses the saved token set; the old refresh token is never sent again.
    const restarted = service()
    expect(await restarted.getAccessToken()).toBe(refreshed)
    clock += 56 * 60 * 1000
    expect(await restarted.getAccessToken()).not.toBe(refreshed)
    expect(logs.join('\n')).not.toContain('refresh rejected')
    noteSecrets()
  })

  it('waits for earliest_refresh_at while the token is still usable', async () => {
    fake.options.earliestRefreshAt = Math.floor((Date.now() + 58 * 60 * 1000) / 1000)
    const auth = await signedIn()
    const first = await auth.getAccessToken()
    nearExpiry()
    expect(await auth.getAccessToken()).toBe(first)
    expect(fake.tokenRequests).toHaveLength(1)
    clock = Date.now() + 59 * 60 * 1000
    expect(await auth.getAccessToken()).not.toBe(first)
  })

  it('clears the tokens on a terminal refresh error and asks to sign in again', async () => {
    const auth = await signedIn()
    nearExpiry()
    fake.options.refreshReply = () => ({ status: 400, body: { error: 'refresh_token_reused' } })
    expect((await failure(auth.getAccessToken())).code).toBe('sign-in-again')
    expect(await auth.status()).toEqual({ state: 'sign-in-again', reason: 'expired' })
    const record = await savedRecord()
    expect(record).toMatchObject({ subject: 'user-subject-1', ended: 'expired' })
    expect(JSON.stringify(record)).not.toMatch(/eyJ|rt-/)
    expect(await service().status()).toEqual({ state: 'sign-in-again', reason: 'expired' })
    noteSecrets()
  })

  it.each([
    [400, { error: 'invalid_grant' }],
    [400, { error: 'invalid_refresh_token' }],
    [400, { error: 'token_expired' }],
    [400, { error: 'refresh_token_expired' }],
    [400, { error: 'refresh_token_invalidated' }],
    [400, { error: 'unauthorized_client' }],
    [400, { error: 'invalid_scope' }],
    [400, { error: 'some_future_error' }],
    [403, { detail: 'not an OAuth error body' }],
    [404, undefined],
  ])('treats a %i reply %j as permanent, without retrying', async (status, body) => {
    const auth = await signedIn()
    nearExpiry()
    fake.options.refreshReply = () => ({ status, body })
    expect((await failure(auth.getAccessToken())).code).toBe('sign-in-again')
    expect((await savedRecord())?.['tokens']).toBeUndefined()
    expect(await auth.status()).toEqual({ state: 'sign-in-again', reason: 'expired' })
    // No loop: later calls fail at once without asking OpenAI again.
    const refreshes = () =>
      fake.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token')
    expect(refreshes()).toHaveLength(1)
    expect((await failure(auth.getAccessToken())).code).toBe('sign-in-again')
    expect((await failure(service().getAccessToken())).code).toBe('sign-in-again')
    expect(refreshes()).toHaveLength(1)
    // The registration is kept: signing in again reuses the issued client.
    expect(settings.chatgptAuth?.accounts).toHaveLength(1)
  })

  it('drops the registration on invalid_client so the next sign-in registers again', async () => {
    const auth = await signedIn()
    nearExpiry()
    fake.options.refreshReply = () => ({ status: 401, body: { error: 'invalid_client' } })
    expect((await failure(auth.getAccessToken())).code).toBe('sign-in-again')
    expect(settings.chatgptAuth?.accounts).toEqual([])
    delete fake.options.refreshReply
    await auth.login(session())
    expect(fake.authorizeRequests[1]?.get('client_id')).toBe('dynamic_agent_client')
  })

  it.each([408, 429, 500, 502, 503])(
    'keeps the credentials on a %i refresh reply and retries later',
    async (status) => {
      const auth = await signedIn()
      clock = Date.now() + 61 * 60 * 1000
      fake.options.refreshReply = () => ({ status, body: { error: 'temporarily_unavailable' } })
      expect((await failure(auth.getAccessToken())).code).toBe('server')
      expect((await savedRecord())?.['tokens']).toBeDefined()
      expect(await auth.status()).toEqual({ state: 'signed-in', email: 'person@example.com' })
      delete fake.options.refreshReply
      expect(await auth.getAccessToken()).toMatch(/^eyJ/)
    },
  )

  it('keeps the credentials on 5xx and network failures', async () => {
    const auth = await signedIn()
    const first = await auth.getAccessToken()
    nearExpiry()
    fake.options.refreshReply = () => ({ status: 503, body: { error: 'unavailable' } })
    // Time left: the current token still works.
    expect(await auth.getAccessToken()).toBe(first)
    clock = Date.now() + 61 * 60 * 1000
    expect((await failure(auth.getAccessToken())).code).toBe('server')
    expect(await auth.status()).toEqual({ state: 'signed-in', email: 'person@example.com' })
    await fake.close()
    expect((await failure(auth.getAccessToken())).code).toBe('network')
    expect((await savedRecord())?.['tokens']).toBeDefined()
  })

  it('ends the session when a refresh drops ChatGPT plan use', async () => {
    const auth = await signedIn()
    nearExpiry()
    fake.options.scope = 'openid email'
    expect((await failure(auth.getAccessToken())).code).toBe('sign-in-again')
    expect(await auth.status()).toEqual({ state: 'sign-in-again', reason: 'plan-not-enabled' })
  })

  it('verifies a refreshed ID token and fails closed on another account', async () => {
    const auth = await signedIn()
    nearExpiry()
    fake.options.refreshIdToken = true
    expect(await auth.getAccessToken()).toMatch(/^eyJ/)
    clock += 56 * 60 * 1000
    fake.options.subject = 'user-subject-2'
    expect((await failure(auth.getAccessToken())).code).toBe('sign-in-again')
  })

  it('reports signed-out without credentials', async () => {
    expect((await failure(service().getAccessToken())).code).toBe('signed-out')
  })
})

describe('sign-out', () => {
  it('revokes the refresh token and clears credentials, keeping the registration', async () => {
    const auth = await signedIn()
    const refreshToken = fake.currentRefreshToken()
    expect(await auth.signOut()).toEqual({ confirmed: true })
    expect(Object.fromEntries(fake.revokeRequests[0] ?? [])).toEqual({
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: 'oaiapp_test_client',
    })
    expect(await savedRecord()).toBeNull()
    expect(await auth.status()).toEqual({ state: 'signed-out' })
    expect(settings.chatgptAuth?.accounts).toHaveLength(1)
    // Signing in again reuses the client, without the cleared ID token as a hint.
    await auth.login(session())
    expect(fake.authorizeRequests[1]?.get('client_id')).toBe('oaiapp_test_client')
    expect(fake.authorizeRequests[1]?.has('id_token_hint')).toBe(false)
    noteSecrets()
  })

  it('clears locally and says so when revocation cannot be confirmed', async () => {
    const auth = await signedIn()
    fake.options.revokeReply = () => ({ status: 503 })
    expect(await auth.signOut()).toEqual({ confirmed: false, message: UNCONFIRMED_SIGN_OUT })
    expect(fake.revokeRequests).toHaveLength(3)
    expect(await savedRecord()).toBeNull()
    expect(UNCONFIRMED_SIGN_OUT).toContain("couldn't confirm sign-out at OpenAI")
  })

  it('does not retry a 4xx revocation, and still clears', async () => {
    const auth = await signedIn()
    fake.options.revokeReply = () => ({ status: 400, body: { error: 'invalid_request' } })
    expect((await auth.signOut()).confirmed).toBe(false)
    expect(fake.revokeRequests).toHaveLength(1)
    expect(await auth.status()).toEqual({ state: 'signed-out' })
  })

  it('clears locally when OpenAI cannot be reached at all', async () => {
    const auth = await signedIn()
    await fake.close()
    expect((await auth.signOut()).confirmed).toBe(false)
    expect(await savedRecord()).toBeNull()
  })

  it('cancels a sign-in in progress', async () => {
    const auth = service()
    let opened: () => void = () => {}
    const browserOpened = new Promise<void>((resolve) => (opened = resolve))
    const login = auth.login(
      session({
        openUrl: () => {
          opened()
          return Promise.resolve()
        },
      }),
    )
    const outcome = failure(login)
    await browserOpened
    await auth.signOut()
    expect((await outcome).code).toBe('cancelled')
    expect(await savedRecord()).toBeNull()
  })
})

// Windows takes about two seconds to refuse a loopback connection to a closed port.
describe('loopback listener', { timeout: 20_000 }, () => {
  it('binds 127.0.0.1 only, and accepts only GET /auth/callback for its own host', async () => {
    const listener = await startCallbackListener({
      signal: new AbortController().signal,
      timeout: 10_000,
    })
    const port = portOf(listener.redirectUri)
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${String(port)}/auth/callback`)
    // Not on IPv6 loopback or any other address.
    expect(await connect(port, '::1')).toMatch(/^E[A-Z]+$/)
    const status = (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${String(port)}${path}`, init).then((r) => r.status)
    expect(await status('/callback?code=x')).toBe(404)
    expect(await status('/auth/callback/?code=x')).toBe(404)
    expect(await status('/auth/%63allback?code=x')).toBe(404)
    expect(await status('/auth/callback?code=x', { method: 'POST' })).toBe(405)
    expect(
      await new Promise((resolve) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/auth/callback?code=x',
            headers: { host: 'rebound.example' },
          },
          (r) => {
            r.resume()
            resolve(r.statusCode)
          },
        )
        req.end()
      }),
    ).toBe(400)
    // None of those settled the attempt; the real callback does, once.
    const response = await fetch(`${listener.redirectUri}?code=abc&state=s`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    const body = await response.text()
    expect(body).not.toContain('abc')
    expect((await listener.result).get('code')).toBe('abc')
    await listener.close()
    expect(await connect(port)).toBe('ECONNREFUSED')
  })

  it('closes on abort', async () => {
    const controller = new AbortController()
    const listener = await startCallbackListener({ signal: controller.signal, timeout: 10_000 })
    controller.abort()
    await expect(listener.result).rejects.toMatchObject({ code: 'cancelled' })
    await listener.close()
    expect(await connect(portOf(listener.redirectUri))).toBe('ECONNREFUSED')
  })

  it('closes on timeout, and the sign-in reports it', async () => {
    let port = 0
    const auth = service({ loginTimeout: 50 })
    const error = await failure(
      auth.login(
        session({
          openUrl: (url) => {
            port = portOf(new URL(url).searchParams.get('redirect_uri') ?? '')
            return Promise.resolve()
          },
        }),
      ),
    )
    expect(error.code).toBe('timed-out')
    expect(await connect(port)).toBe('ECONNREFUSED')
  })

  it('closes when the sign-in is aborted', async () => {
    const controller = new AbortController()
    let port = 0
    const login = service().login(
      session({
        signal: controller.signal,
        openUrl: (url) => {
          port = portOf(new URL(url).searchParams.get('redirect_uri') ?? '')
          controller.abort()
          return Promise.resolve()
        },
      }),
    )
    expect((await failure(login)).code).toBe('cancelled')
    expect(await connect(port)).toBe('ECONNREFUSED')
    expect(fake.tokenRequests).toHaveLength(0)
  })

  it('closes when the browser cannot be opened', async () => {
    let port = 0
    const error = await failure(
      service().login(
        session({
          openUrl: (url) => {
            port = portOf(new URL(url).searchParams.get('redirect_uri') ?? '')
            return Promise.reject(new Error('no browser'))
          },
        }),
      ),
    )
    expect(error.code).toBe('browser')
    expect(await connect(port)).toBe('ECONNREFUSED')
  })
})

describe('secrets stay out of errors and logs', () => {
  it('only ever uses production endpoints outside tests or off loopback', () => {
    expect(() =>
      openChatgptAuth(
        { keys: createKeyStore({ userDataPath: dir, safeStorage }), settings },
        { ...PRODUCTION, token: 'https://evil.example/token' },
      ),
    ).toThrow('ChatGPT sign-in endpoints are fixed.')
  })

  it('redacts token-shaped text', () => {
    const jwt = fake.signJwt({ sub: 'x' })
    const text = redact(
      `Bearer abc.def ${jwt} ?code=c1&state=s1&refresh_token=r1 {"access_token":"a1"}`,
    )
    for (const secret of [jwt, 'abc.def', 'c1', 's1', 'r1', 'a1'])
      expect(text).not.toContain(secret)
  })

  it('never puts a token, code or verifier in a thrown error or a log line', async () => {
    // Runs a failing flow of each kind here too, so this test stands alone.
    const auth = await signedIn()
    clock = Date.now() + 56 * 60 * 1000
    fake.options.refreshReply = () => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: fake.currentRefreshToken() },
    })
    await failure(auth.getAccessToken())
    noteSecrets()
    for (const idToken of fake.issuedIdTokens) seenSecrets.add(idToken)
    const errorText = seenErrors
      .map((error) =>
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}\n${String(error.cause)}`
          : String(error),
      )
      .join('\n')
    const logText = logs.join('\n')
    expect(seenSecrets.size).toBeGreaterThan(3)
    expect(seenErrors.length).toBeGreaterThan(10)
    for (const secret of seenSecrets) {
      expect(errorText).not.toContain(secret)
      expect(logText).not.toContain(secret)
    }
    expect(errorText).not.toMatch(/eyJ[\w-]+\.[\w-]+/)
    expect(logText).not.toMatch(/eyJ[\w-]+\.[\w-]+/)
    // Nothing but the record lives in the secrets folder, and settings has no tokens.
    expect(await readdir(join(dir, 'secrets'))).toEqual(['chatgpt-plan.enc'])
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).not.toMatch(/eyJ|rt-/)
  })
})
