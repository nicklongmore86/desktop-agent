/**
 * Test-only: a fake OpenAI auth server on 127.0.0.1 serving discovery, JWKS,
 * authorize (a 302 back to the app's callback), token (code exchange and
 * rotating refresh) and revocation. Never imported by the app.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Endpoints } from './config'

export interface Reply {
  status: number
  body?: unknown
}

export interface FakeOpenAi {
  endpoints: Endpoints
  issuer: string
  /** What the browser does: follows authorize's redirect to the app's callback. */
  openUrl: (url: string) => Promise<void>
  /** Every authorize request's query. */
  authorizeRequests: URLSearchParams[]
  /** Every token request's form, refreshes included. */
  tokenRequests: URLSearchParams[]
  revokeRequests: URLSearchParams[]
  /** The refresh token the server will accept next. */
  currentRefreshToken: () => string | undefined
  /** Signs a JWT with the server's key (or another), for ID tokens the tests build. */
  signJwt: (
    claims: Record<string, unknown>,
    key?: KeyObject,
    header?: Record<string, unknown>,
  ) => string
  /** Behaviour the tests change. */
  options: {
    issuedClientId: string
    subject: string
    email: string
    /** Overrides the callback query (after code and state are set). */
    callback?: (query: URLSearchParams, authorize: URLSearchParams) => void
    scope: string
    /** Changes the ID token's claims or the key that signs it. */
    idToken?: (claims: Record<string, unknown>) => Record<string, unknown>
    signingKey?: KeyObject
    /** Replaces the finished ID token, to forge headers or signatures. */
    rawIdToken?: (token: string) => string
    /** Replaces the token endpoint's reply to a refresh. */
    refreshReply?: () => Reply | Promise<Reply>
    refreshIdToken: boolean
    revokeReply: () => Reply
    earliestRefreshAt?: number | string
    expiresIn: number
  }
  close: () => Promise<void>
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (text += chunk))
    request.on('end', () => {
      resolve(text)
    })
    request.on('error', reject)
  })

const json = (response: ServerResponse, { status, body }: Reply) => {
  if (body === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'test-key'
  const random = () => randomBytes(16).toString('hex')
  const codes = new Map<string, { authorize: URLSearchParams; clientId: string }>()
  let refreshToken: string | undefined
  let refreshClient: { clientId: string; nonce: string } | undefined
  const authorizeRequests: URLSearchParams[] = []
  const tokenRequests: URLSearchParams[] = []
  const revokeRequests: URLSearchParams[] = []
  let base = ''

  const signJwt = (
    claims: Record<string, unknown>,
    key: KeyObject = privateKey,
    header: Record<string, unknown> = { alg: 'RS256', kid, typ: 'JWT' },
  ) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const input = `${encode(header)}.${encode(claims)}`
    return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`
  }

  const fake: FakeOpenAi = {
    endpoints: { issuer: '', authorize: '', token: '', discovery: '' },
    issuer: '',
    authorizeRequests,
    tokenRequests,
    revokeRequests,
    currentRefreshToken: () => refreshToken,
    signJwt,
    options: {
      issuedClientId: 'oaiapp_test_client',
      subject: 'user-subject-1',
      email: 'person@example.com',
      scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
      refreshIdToken: false,
      revokeReply: () => ({ status: 200 }),
      expiresIn: 3600,
    },
    async openUrl(url) {
      const response = await fetch(url, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (!location) throw new Error('authorize did not redirect')
      await fetch(location)
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections()
      }),
  }

  const idTokenFor = (clientId: string, nonce: string | undefined) => {
    const seconds = Math.floor(Date.now() / 1000)
    let claims: Record<string, unknown> = {
      iss: fake.issuer,
      aud: clientId,
      sub: fake.options.subject,
      email: fake.options.email,
      iat: seconds,
      exp: seconds + 3600,
      ...(nonce !== undefined ? { nonce } : {}),
    }
    if (fake.options.idToken) claims = fake.options.idToken(claims)
    const token = signJwt(claims, fake.options.signingKey ?? privateKey)
    return fake.options.rawIdToken ? fake.options.rawIdToken(token) : token
  }
  const issueTokens = (clientId: string, nonce: string | undefined, withIdToken: boolean) => {
    refreshToken = `rt-${random()}`
    return {
      access_token: signJwt({
        aud: 'https://api.openai.com/v1',
        client_id: clientId,
        jti: random(),
      }),
      refresh_token: refreshToken,
      ...(withIdToken ? { id_token: idTokenFor(clientId, nonce) } : {}),
      token_type: 'Bearer',
      expires_in: fake.options.expiresIn,
      scope: fake.options.scope,
      ...(fake.options.earliestRefreshAt !== undefined
        ? { earliest_refresh_at: fake.options.earliestRefreshAt }
        : {}),
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', base)
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      json(response, {
        status: 200,
        body: {
          issuer: fake.issuer,
          authorization_endpoint: `${base}/api/accounts/authorize`,
          token_endpoint: `${base}/api/accounts/oauth/token`,
          jwks_uri: `${base}/.well-known/jwks.json`,
          revocation_endpoint: `${base}/oauth/revoke`,
        },
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      const jwk = publicKey.export({ format: 'jwk' })
      json(response, { status: 200, body: { keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] } })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/accounts/authorize') {
      const query = url.searchParams
      authorizeRequests.push(query)
      const requested = query.get('client_id') ?? ''
      const clientId =
        requested === 'dynamic_agent_client' ? fake.options.issuedClientId : requested
      const code = `code-${random()}`
      codes.set(code, { authorize: query, clientId })
      const callback = new URLSearchParams({
        code,
        state: query.get('state') ?? '',
        scope: fake.options.scope,
        ...(requested === 'dynamic_agent_client' ? { client_id: clientId } : {}),
      })
      fake.options.callback?.(callback, query)
      response.writeHead(302, {
        location: `${query.get('redirect_uri') ?? ''}?${callback.toString()}`,
      })
      response.end()
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/accounts/oauth/token') {
      const form = new URLSearchParams(await readBody(request))
      tokenRequests.push(form)
      if (form.get('grant_type') === 'authorization_code') {
        const pending = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (
          !pending ||
          form.get('client_id') !== pending.clientId ||
          form.get('redirect_uri') !== pending.authorize.get('redirect_uri') ||
          form.get('resource') !== pending.authorize.get('resource') ||
          challenge !== pending.authorize.get('code_challenge')
        ) {
          json(response, { status: 400, body: { error: 'invalid_grant' } })
          return
        }
        const nonce = pending.authorize.get('nonce') ?? ''
        refreshClient = { clientId: pending.clientId, nonce }
        json(response, { status: 200, body: issueTokens(pending.clientId, nonce, true) })
        return
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (fake.options.refreshReply) {
          json(response, await fake.options.refreshReply())
          return
        }
        if (!refreshClient || form.get('client_id') !== refreshClient.clientId) {
          json(response, { status: 401, body: { error: 'invalid_client' } })
          return
        }
        if (form.get('refresh_token') !== refreshToken) {
          json(response, { status: 400, body: { error: 'refresh_token_reused' } })
          return
        }
        json(response, {
          status: 200,
          body: issueTokens(refreshClient.clientId, undefined, fake.options.refreshIdToken),
        })
        return
      }
      json(response, { status: 400, body: { error: 'unsupported_grant_type' } })
      return
    }
    if (request.method === 'POST' && url.pathname === '/oauth/revoke') {
      revokeRequests.push(new URLSearchParams(await readBody(request)))
      json(response, fake.options.revokeReply())
      return
    }
    json(response, { status: 404, body: { error: 'not_found' } })
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      resolve()
    })
  })
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  fake.issuer = base
  fake.endpoints = {
    issuer: base,
    authorize: `${base}/api/accounts/authorize`,
    token: `${base}/api/accounts/oauth/token`,
    discovery: `${base}/.well-known/openid-configuration`,
  }
  return fake
}
