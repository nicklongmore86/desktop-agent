import { randomUUID } from 'node:crypto'
import type { KeyStore } from '../../secrets'
import type { ChatgptAuthSettings, SettingsStore } from '../../storage/settings-store'
import {
  AGENT_NAME,
  CREDENTIAL_ID,
  DYNAMIC_CLIENT_ID,
  EXPIRY_SLACK,
  LOGIN_TIMEOUT,
  PLAN_SCOPE,
  PRODUCTION,
  REFRESH_MARGIN,
  RESOURCE,
  SCOPES,
  type Endpoints,
} from './config'
import { startCallbackListener } from './callback-server'
import {
  clientIdSchema,
  parseCredential,
  parseInstant,
  parseScopes,
  parseTokenResponse,
  type Credential,
  type TokenResponse,
} from './credentials'
import { ChatgptAuthError, redact } from './errors'
import { oauthError, send, type Fetch } from './http'
import { Jwks, verifyIdToken } from './id-token'
import { codeChallenge, randomValue, safeEqual } from './pkce'

export interface LoginSession {
  /** Cancels the attempt: the listener closes and nothing is saved. */
  signal: AbortSignal
  /** Opens the system browser. Called once, after the listener is up. */
  openUrl: (url: string) => Promise<void>
  /** Register another ChatGPT account instead of signing in again to the saved one. */
  newAccount?: boolean
  /** Show the consent screen again (prompt=consent), to allow plan use after a decline. */
  reconsent?: boolean
}

/** All the renderer ever learns: no token, code or client id. */
export type ChatgptAuthStatus =
  | { state: 'signed-out' }
  | { state: 'signing-in' }
  | { state: 'signed-in'; email?: string }
  | { state: 'sign-in-again'; reason: 'expired' | 'plan-not-enabled' | 'unreadable' }

export interface SignOutResult {
  /** OpenAI confirmed the refresh token is revoked (or there was none to revoke). */
  confirmed: boolean
  message?: string
}

export interface ChatgptAuth {
  /** One sign-in attempt; rejects with ChatgptAuthError. */
  login: (session: LoginSession) => Promise<ChatgptAuthStatus>
  /** A current access token, refreshed first when it is near expiry. Main process only. */
  getAccessToken: () => Promise<string>
  status: () => Promise<ChatgptAuthStatus>
  signOut: () => Promise<SignOutResult>
}

export interface ChatgptAuthDeps {
  keys: KeyStore
  settings: Pick<SettingsStore, 'chatgptAuth' | 'setChatgptAuth'>
  /** Receives redacted, fixed event lines only. */
  log?: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fetch?: Fetch
  loginTimeout?: number
}

/** Refresh errors after which the refresh token can never work again. */
const TERMINAL_REFRESH_ERRORS: ReadonlySet<string> = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'invalid_client',
])
const REVOKE_ATTEMPTS = 3
export const UNCONFIRMED_SIGN_OUT =
  "Signed out on this computer, but couldn't confirm sign-out at OpenAI. You can disconnect Desktop Agent in ChatGPT Settings."

interface Discovery {
  jwks: Jwks
  revocation: string | undefined
}

/** Read through a call, since TypeScript narrows `signal.aborted` to false after one check. */
const isAborted = (signal: AbortSignal): boolean => signal.aborted

/** The test server runs on loopback; anything else must be OpenAI's production endpoints. */
function checkEndpoints(endpoints: Endpoints): void {
  if (endpoints === PRODUCTION) return
  const urls = [endpoints.issuer, endpoints.authorize, endpoints.token, endpoints.discovery]
  const loopback = urls.every((url) => {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  })
  if (!loopback || !process.env['VITEST']) throw new Error('ChatGPT sign-in endpoints are fixed.')
}

/**
 * The sign-in service. `endpoints` exists for the tests' fake server; the app
 * builds this through createChatgptAuth (index.ts), which always uses PRODUCTION.
 */
export function openChatgptAuth(
  deps: ChatgptAuthDeps,
  endpoints: Endpoints = PRODUCTION,
): ChatgptAuth {
  checkEndpoints(endpoints)
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      }))
  const log = (line: string) => {
    try {
      deps.log?.(redact(`chatgpt-auth: ${line}`))
    } catch {
      // Logging never fails an operation.
    }
  }
  const store = deps.keys.forConnection(CREDENTIAL_ID)
  const issuerOrigin = new URL(endpoints.issuer).origin

  // --- discovery ---------------------------------------------------------
  let discovery: Promise<Discovery> | undefined
  function discover(signal?: AbortSignal): Promise<Discovery> {
    if (discovery) return discovery
    const attempt = (async (): Promise<Discovery> => {
      const response = await send(fetchImpl, endpoints.discovery, { method: 'GET' }, signal)
      if (response.status >= 500) throw new ChatgptAuthError('server')
      const document = response.json as Record<string, unknown> | undefined
      if (response.status !== 200 || document?.['issuer'] !== endpoints.issuer)
        throw new ChatgptAuthError('discovery')
      // Keys and revocation must come from the issuer itself.
      const sameOrigin = (value: unknown): string | undefined => {
        if (typeof value !== 'string') return undefined
        try {
          const url = new URL(value)
          return url.origin === issuerOrigin && !url.username && !url.password
            ? url.href
            : undefined
        } catch {
          return undefined
        }
      }
      const jwksUri = sameOrigin(document['jwks_uri'])
      if (!jwksUri) throw new ChatgptAuthError('discovery')
      const jwks = new Jwks(async () => {
        const keys = await send(fetchImpl, jwksUri, { method: 'GET' })
        if (keys.status !== 200)
          throw new ChatgptAuthError(keys.status >= 500 ? 'server' : 'discovery')
        return keys.json
      }, now)
      return { jwks, revocation: sameOrigin(document['revocation_endpoint']) }
    })()
    // Cache only a success, so a failed lookup is tried again next time.
    discovery = attempt
    attempt.catch(() => {
      if (discovery === attempt) discovery = undefined
    })
    return attempt
  }

  // --- credential record -------------------------------------------------
  /** undefined: not read yet; null: none saved. */
  let record: Credential | null | undefined
  let unreadable = false
  async function load(): Promise<Credential | null> {
    if (record !== undefined) return record
    let text: string | null
    try {
      text = await store.get()
    } catch {
      text = null
      unreadable = true
    }
    const parsed = text === null ? null : (parseCredential(text) ?? null)
    if (text !== null && !parsed) unreadable = true
    record = parsed && parsed.issuer === endpoints.issuer ? parsed : null
    return record
  }
  async function save(next: Credential): Promise<void> {
    try {
      await store.set(JSON.stringify(next))
    } catch {
      throw new ChatgptAuthError('storage')
    }
    record = next
    unreadable = false
  }
  async function clear(): Promise<void> {
    record = null
    unreadable = false
    try {
      await store.clear()
    } catch {
      throw new ChatgptAuthError('storage')
    }
  }
  /** Drops the tokens but keeps the ID token as a sign-in hint. */
  async function end(current: Credential, reason: NonNullable<Credential['ended']>): Promise<void> {
    const { tokens: _tokens, ...rest } = current
    const ended: Credential = { ...rest, ended: reason, savedAt: new Date(now()).toISOString() }
    record = ended
    try {
      await store.set(JSON.stringify(ended))
    } catch {
      // The tokens must not survive even if the hint cannot be kept.
      await clear().catch(() => {})
    }
  }

  // Every read and change of the record runs here, one at a time, so two callers
  // can never both spend the same rotating refresh token.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }

  // --- settings ----------------------------------------------------------
  /** The host id is chosen and saved before the first sign-in, then never changes. */
  async function registrations(): Promise<ChatgptAuthSettings> {
    const saved = deps.settings.chatgptAuth
    if (saved) return saved
    const created: ChatgptAuthSettings = { hostId: `urn:uuid:${randomUUID()}`, accounts: [] }
    try {
      await deps.settings.setChatgptAuth(created)
    } catch {
      throw new ChatgptAuthError('storage')
    }
    return created
  }
  async function remember(subject: string, clientId: string): Promise<void> {
    const saved = await registrations()
    const accounts = [
      ...saved.accounts.filter((account) => account.subject !== subject),
      { subject, clientId },
    ].slice(-32)
    try {
      await deps.settings.setChatgptAuth({ ...saved, accounts, current: subject })
    } catch {
      throw new ChatgptAuthError('storage')
    }
  }
  async function forget(clientId: string): Promise<void> {
    const saved = deps.settings.chatgptAuth
    if (!saved) return
    const accounts = saved.accounts.filter((account) => account.clientId !== clientId)
    await deps.settings.setChatgptAuth({ ...saved, accounts }).catch(() => {})
  }

  // --- token endpoint ----------------------------------------------------
  function tokensFrom(
    response: TokenResponse,
    previous?: { refreshToken: string; scopes: string[] },
  ): NonNullable<Credential['tokens']> | undefined {
    const refreshToken = response.refresh_token ?? previous?.refreshToken
    if (!refreshToken) return undefined
    const earliest = parseInstant(response.earliest_refresh_at)
    return {
      accessToken: response.access_token,
      refreshToken,
      tokenType: 'Bearer',
      expiresAt: now() + response.expires_in * 1000,
      ...(earliest !== undefined ? { earliestRefreshAt: earliest } : {}),
      // A refresh that omits scope keeps the grant it had.
      scopes: response.scope !== undefined ? parseScopes(response.scope) : (previous?.scopes ?? []),
    }
  }

  async function revoke(current: Credential): Promise<boolean> {
    if (!current.tokens) return true
    let endpoint: string | undefined
    try {
      endpoint = (await discover()).revocation
    } catch {
      endpoint = undefined
    }
    if (!endpoint) return false
    for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1))
      try {
        const response = await send(fetchImpl, endpoint, {
          method: 'POST',
          form: {
            token: current.tokens.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: current.clientId,
          },
        })
        // An empty 200 is success, including for a token that was already invalid.
        if (response.status === 200) return true
        log(`revocation returned ${String(response.status)}`)
        if (response.status < 500) return false
      } catch {
        log('revocation request failed')
      }
    }
    return false
  }

  async function refresh(current: Credential & { tokens: Tokens }): Promise<string> {
    let response
    try {
      response = await send(fetchImpl, endpoints.token, {
        method: 'POST',
        form: {
          grant_type: 'refresh_token',
          client_id: current.clientId,
          refresh_token: current.tokens.refreshToken,
          resource: RESOURCE,
        },
      })
    } catch (error) {
      log('refresh request failed')
      throw error
    }
    if (response.status >= 500) {
      log(`refresh returned ${String(response.status)}`)
      throw new ChatgptAuthError('server')
    }
    if (response.status !== 200) {
      const code = oauthError(response.json)
      log(`refresh rejected (${code ?? String(response.status)})`)
      if (code === undefined || !TERMINAL_REFRESH_ERRORS.has(code))
        throw new ChatgptAuthError('token-exchange')
      if (code === 'invalid_client') await forget(current.clientId)
      await end(current, 'expired')
      throw new ChatgptAuthError('sign-in-again')
    }
    const parsed = parseTokenResponse(response.json)
    const tokens = parsed && tokensFrom(parsed, current.tokens)
    if (!parsed || !tokens) {
      log('refresh returned an unexpected response')
      throw new ChatgptAuthError('token-exchange')
    }
    let idToken = current.idToken
    if (parsed.id_token !== undefined) {
      try {
        const { jwks } = await discover()
        const claims = await verifyIdToken(parsed.id_token, jwks, {
          issuer: endpoints.issuer,
          clientId: current.clientId,
          now: now(),
        })
        if (claims.sub !== current.subject) throw new ChatgptAuthError('account-mismatch')
        idToken = parsed.id_token
      } catch (error) {
        if (error instanceof ChatgptAuthError && error.transient) throw error
        // The rotated tokens cannot be trusted for this account: fail closed.
        log('refresh returned an identity that did not verify')
        await end(current, 'expired')
        throw new ChatgptAuthError('sign-in-again')
      }
    }
    if (!tokens.scopes.includes(PLAN_SCOPE)) {
      log('refresh no longer grants ChatGPT plan use')
      await end(current, 'plan-not-enabled')
      throw new ChatgptAuthError('sign-in-again')
    }
    const next: Credential = {
      ...current,
      idToken,
      tokens,
      savedAt: new Date(now()).toISOString(),
    }
    try {
      await save(next)
    } catch {
      // The old refresh token is spent; keep the new one for this session at least.
      record = next
      log('could not save refreshed credentials')
    }
    return tokens.accessToken
  }

  // --- status ------------------------------------------------------------
  /** Aborts the sign-in in progress, so a sign-out cannot be undone by it finishing. */
  let signingIn: AbortController | undefined
  function statusOf(current: Credential | null): ChatgptAuthStatus {
    if (!current)
      return unreadable ? { state: 'sign-in-again', reason: 'unreadable' } : { state: 'signed-out' }
    if (!current.tokens) return { state: 'sign-in-again', reason: current.ended ?? 'expired' }
    return current.email !== undefined
      ? { state: 'signed-in', email: current.email }
      : { state: 'signed-in' }
  }

  // --- login -------------------------------------------------------------
  async function attempt(session: LoginSession): Promise<ChatgptAuthStatus> {
    const { signal } = session
    if (isAborted(signal)) throw new ChatgptAuthError('cancelled')
    const settings = await registrations()
    const previous = await serial(load)
    const registration = session.newAccount
      ? undefined
      : settings.accounts.find((account) => account.subject === settings.current)
    const requestClientId = registration?.clientId ?? DYNAMIC_CLIENT_ID
    const { jwks } = await discover(signal)

    const state = randomValue()
    const nonce = randomValue()
    const verifier = randomValue()
    const listener = await startCallbackListener({
      signal,
      timeout: deps.loginTimeout ?? LOGIN_TIMEOUT,
    })
    let params: URLSearchParams
    try {
      const url = new URL(endpoints.authorize)
      const query: Record<string, string> = {
        response_type: 'code',
        client_id: requestClientId,
        redirect_uri: listener.redirectUri,
        scope: SCOPES.join(' '),
        resource: RESOURCE,
        state,
        nonce,
        code_challenge: codeChallenge(verifier),
        code_challenge_method: 'S256',
        ext_agent_host_id: settings.hostId,
      }
      if (!registration) query['agent_name_hint'] = AGENT_NAME
      // The retained ID token (and email) only identify the account to OpenAI's authorize page.
      if (registration && previous?.subject === registration.subject) {
        query['id_token_hint'] = previous.idToken
        if (previous.email) query['login_hint'] = previous.email
      }
      if (session.reconsent) query['prompt'] = 'consent'
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
      log(registration ? 'sign-in started' : 'registration started')
      try {
        await session.openUrl(url.href)
      } catch {
        throw new ChatgptAuthError('browser')
      }
      params = await listener.result
    } finally {
      await listener.close()
    }

    // Validate state before trusting anything else in the callback, the error included.
    const returnedState = params.get('state')
    if (returnedState === null || !safeEqual(returnedState, state))
      throw new ChatgptAuthError('state-mismatch')
    const error = params.get('error')
    if (error !== null) {
      log(`authorization returned ${error === 'access_denied' ? 'access_denied' : 'an error'}`)
      throw new ChatgptAuthError(
        error === 'access_denied' ? 'access-denied' : 'authorization-failed',
      )
    }
    const code = params.get('code')
    if (!code || code.length > 4096) throw new ChatgptAuthError('invalid-callback')
    const returnedClientId = params.get('client_id')
    let clientId: string
    if (registration) {
      // A reauthorization keeps its client; a different one is never adopted.
      if (returnedClientId !== null && returnedClientId !== registration.clientId)
        throw new ChatgptAuthError('invalid-callback')
      clientId = registration.clientId
    } else {
      const issued = clientIdSchema.safeParse(returnedClientId)
      if (!issued.success) throw new ChatgptAuthError('invalid-callback')
      clientId = issued.data
    }
    if (isAborted(signal)) throw new ChatgptAuthError('cancelled')

    const response = await send(
      fetchImpl,
      endpoints.token,
      {
        method: 'POST',
        form: {
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: listener.redirectUri,
          resource: RESOURCE,
        },
      },
      signal,
    )
    if (response.status >= 500) throw new ChatgptAuthError('server')
    if (response.status !== 200) {
      log(`code exchange rejected (${oauthError(response.json) ?? String(response.status)})`)
      throw new ChatgptAuthError('token-exchange')
    }
    const parsed = parseTokenResponse(response.json)
    const tokens = parsed && tokensFrom(parsed)
    if (!parsed?.id_token || !tokens) throw new ChatgptAuthError('token-exchange')
    const claims = await verifyIdToken(parsed.id_token, jwks, {
      issuer: endpoints.issuer,
      clientId,
      nonce,
      now: now(),
    })
    if (registration && claims.sub !== registration.subject)
      throw new ChatgptAuthError('account-mismatch')
    if (parsed.scope === undefined) {
      // Docs: decide from the token response's scopes; the callback's is the fallback.
      const fromCallback = params.get('scope')
      tokens.scopes = fromCallback === null ? [] : parseScopes(fromCallback)
    }
    if (isAborted(signal)) throw new ChatgptAuthError('cancelled')
    // Keep the registration even without plan use, so allowing it later reuses this client.
    await remember(claims.sub, clientId)

    const next: Credential = {
      version: 1,
      issuer: endpoints.issuer,
      subject: claims.sub,
      ...(claims.email !== undefined ? { email: claims.email } : {}),
      clientId,
      hostId: settings.hostId,
      idToken: parsed.id_token,
      tokens,
      savedAt: new Date(now()).toISOString(),
    }
    if (!tokens.scopes.includes(PLAN_SCOPE)) {
      log('sign-in did not grant ChatGPT plan use')
      // These tokens cannot be used for anything here, so the session is ended at once.
      void revoke(next).catch(() => {})
      throw new ChatgptAuthError('plan-not-enabled')
    }
    return serial(async () => {
      if (isAborted(signal)) throw new ChatgptAuthError('cancelled')
      const replaced = await load()
      await save(next)
      log('signed in')
      if (
        replaced?.tokens &&
        (replaced.subject !== next.subject || replaced.clientId !== next.clientId)
      )
        void revoke(replaced).catch(() => {})
      return statusOf(next)
    })
  }

  return {
    async login(session) {
      if (signingIn) throw new ChatgptAuthError('busy')
      const controller = new AbortController()
      signingIn = controller
      try {
        return await attempt({
          ...session,
          signal: AbortSignal.any([session.signal, controller.signal]),
        })
      } catch (error) {
        if (error instanceof ChatgptAuthError) throw error
        // Anything unexpected is reported without its text.
        throw new ChatgptAuthError('authorization-failed')
      } finally {
        if (signingIn === controller) signingIn = undefined
      }
    },

    getAccessToken: () =>
      serial(async () => {
        const current = await load()
        if (!current) throw new ChatgptAuthError(unreadable ? 'sign-in-again' : 'signed-out')
        const { tokens } = current
        if (!tokens) throw new ChatgptAuthError('sign-in-again')
        const remaining = tokens.expiresAt - now()
        const tooEarly = tokens.earliestRefreshAt !== undefined && now() < tokens.earliestRefreshAt
        if (remaining > REFRESH_MARGIN || (tooEarly && remaining > EXPIRY_SLACK))
          return tokens.accessToken
        try {
          return await refresh({ ...current, tokens })
        } catch (error) {
          // A temporary failure keeps the credentials, and a token with time left still works.
          if (error instanceof ChatgptAuthError && error.transient && remaining > EXPIRY_SLACK)
            return tokens.accessToken
          throw error instanceof ChatgptAuthError ? error : new ChatgptAuthError('network')
        }
      }),

    status: () =>
      serial(async () => {
        const current = await load()
        return signingIn ? { state: 'signing-in' } : statusOf(current)
      }),

    signOut: () => {
      signingIn?.abort()
      return serial(async () => {
        const current = await load()
        const confirmed = current ? await revoke(current) : true
        // Cleared whatever OpenAI said: the registration and host id stay for a later sign-in.
        await clear()
        log(confirmed ? 'signed out' : 'signed out locally; revocation not confirmed')
        return confirmed ? { confirmed } : { confirmed, message: UNCONFIRMED_SIGN_OUT }
      })
    },
  }
}

type Tokens = NonNullable<Credential['tokens']>
