import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiErrorEvent, createClaudeClient } from '../agent/client'
import { createGeminiClient, geminiFetch } from '../llm/gemini/client'
import { listGeminiModels } from '../llm/gemini/models'
import { geminiErrorEvent } from '../llm/gemini/errors'
import { connect, readText } from '../llm/openai-compat/http'
import { fakeServer } from '../llm/openai-compat/test-support'
import { ChatgptAuthError, createChatgptAuth } from '../providers/chatgpt-auth'
import { createKeyStore } from '../secrets'
import { send } from '../providers/chatgpt-auth/http'
import { authFailure } from '../providers/adapters/chatgpt-plan'
import {
  classifyNetworkError,
  cloudFetch,
  createGuardedFetch,
  installNetworkTransports,
  isLoopbackUrl,
  isOfficialUrl,
  localFetch,
  networkErrorMessage,
  NetworkFailure,
  type Transport,
} from './network'

const SECRET = 'sk-secret-value-1234567890'
const OFFICIAL = 'https://api.openai.com/v1/models'
const any = (): boolean => true

/** A guarded fetch over a transport that records what it was given. */
function over(respond: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const transport: Transport = async (url, init) => {
    calls.push({ url, init })
    return respond(init)
  }
  return { calls, fetch: createGuardedFetch(any, () => transport) }
}

const rejected = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('what a request may carry', () => {
  it.each(['follow', 'manual', 'error'] as const)(
    'always refuses redirects and sends no credentials, whatever the caller asks (%s)',
    async (redirect) => {
      const { calls, fetch } = over(() => new Response('ok'))
      await fetch(OFFICIAL, { redirect, credentials: 'include', cache: 'default' })
      expect(calls[0]?.init).toMatchObject({
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      })
    },
  )

  it('passes the method, headers and body through to the fixed URL', async () => {
    const { calls, fetch } = over(() => new Response('ok'))
    await fetch(new URL(OFFICIAL), { method: 'POST', headers: { a: 'b' }, body: 'x' })
    expect(calls[0]).toMatchObject({
      url: OFFICIAL,
      init: { method: 'POST', headers: { a: 'b' }, body: 'x' },
    })
  })
})

describe('where a request may go', () => {
  it.each([
    'https://api.anthropic.com/v1/messages',
    'https://api.openai.com/v1/responses',
    'https://auth.openai.com/api/accounts/oauth/token',
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://openrouter.ai/api/v1/models',
  ])('allows the official %s', (url) => {
    expect(isOfficialUrl(new URL(url))).toBe(true)
  })

  it.each([
    'http://api.openai.com/v1/models',
    'https://api.openai.com:8443/v1/models',
    'https://user:pass@api.openai.com/v1/models',
    'https://api.openai.com.evil.example/v1/models',
    'https://evil.example/v1/models',
    'http://127.0.0.1:11434/v1/models',
  ])('refuses %s before it reaches the transport', async (url) => {
    const transport = vi.fn<Transport>()
    const guarded = createGuardedFetch(isOfficialUrl, () => transport)
    expect(await rejected(guarded(url))).toMatchObject({ name: 'NetworkFailure', kind: 'refused' })
    expect(transport).not.toHaveBeenCalled()
  })

  it.each([
    ['http://127.0.0.1:11434/v1', true],
    ['http://[::1]:11434/v1', true],
    ['http://localhost:1234/v1', true],
    ['https://127.0.0.1:11434/v1', false],
    ['http://user:pass@127.0.0.1/v1', false],
    ['http://127.0.0.1.evil.example/v1', false],
    ['http://192.168.1.2:11434/v1', false],
    ['https://api.openai.com/v1', false],
  ])('a local request to %s: allowed is %s', (url, allowed) => {
    expect(isLoopbackUrl(new URL(url))).toBe(allowed)
  })

  it('the shared fetches enforce their own lists', async () => {
    const stub = vi.fn(() => Promise.resolve(new Response('ok')))
    vi.stubGlobal('fetch', stub)
    expect(await rejected(cloudFetch('http://127.0.0.1:11434/v1'))).toMatchObject({
      kind: 'refused',
    })
    expect(await rejected(localFetch(OFFICIAL))).toMatchObject({ kind: 'refused' })
    expect(stub).not.toHaveBeenCalled()
  })

  it('refuses a Request object, whose own settings could not be overridden', async () => {
    const { calls, fetch } = over(() => new Response('ok'))
    expect(await rejected(fetch(new Request(OFFICIAL)))).toMatchObject({ kind: 'refused' })
    expect(calls).toHaveLength(0)
  })
})

describe('before the app is ready', () => {
  it('fails rather than using another transport', async () => {
    const stub = vi.fn(() => Promise.resolve(new Response('ok')))
    vi.stubGlobal('fetch', stub)
    const notInstalled = createGuardedFetch(any, () => undefined)
    expect(await rejected(notInstalled(OFFICIAL))).toMatchObject({ kind: 'not-ready' })
    expect(stub).not.toHaveBeenCalled()
  })

  it('reports a transport that throws synchronously as a failure', async () => {
    // Electron throws "Session can only be received when app is ready" without a promise.
    const guarded = createGuardedFetch(any, () => () => {
      throw new TypeError('Session can only be received when app is ready')
    })
    expect(await rejected(guarded(OFFICIAL))).toBeInstanceOf(NetworkFailure)
  })

  it('cannot have its transports replaced once installed', () => {
    const transport: Transport = () => Promise.resolve(new Response('ok'))
    expect(() => {
      installNetworkTransports({ cloud: transport, local: transport })
    }).toThrow('already installed')
  })
})

describe('failures', () => {
  it('rejects a redirect returned by an equivalent transport and cancels it', async () => {
    let cancelled = false
    const { fetch, calls } = over(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          { status: 302, headers: { location: 'https://evil.example' } },
        ),
    )
    expect(await rejected(fetch(OFFICIAL))).toMatchObject({ kind: 'redirect' })
    expect(cancelled).toBe(true)
    expect(calls[0]?.init.signal?.aborted).toBe(true)
  })

  it.each([
    ['net::ERR_PROXY_CONNECTION_FAILED', 'proxy', 'ERR_PROXY_CONNECTION_FAILED'],
    ['net::ERR_TUNNEL_CONNECTION_FAILED', 'proxy', 'ERR_TUNNEL_CONNECTION_FAILED'],
    ['net::ERR_PROXY_AUTH_UNSUPPORTED', 'proxy', 'ERR_PROXY_AUTH_UNSUPPORTED'],
    ['net::ERR_NO_SUPPORTED_PROXIES', 'proxy', 'ERR_NO_SUPPORTED_PROXIES'],
    ['net::ERR_NETWORK_ACCESS_DENIED', 'proxy', 'ERR_NETWORK_ACCESS_DENIED'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'certificate', 'ERR_CERT_AUTHORITY_INVALID'],
    ['net::ERR_SSL_PROTOCOL_ERROR', 'certificate', 'ERR_SSL_PROTOCOL_ERROR'],
    ['net::ERR_INTERNET_DISCONNECTED', 'offline', 'ERR_INTERNET_DISCONNECTED'],
    ['net::ERR_CONNECTION_REFUSED', 'unreachable', 'ERR_CONNECTION_REFUSED'],
    ['net::ERR_NAME_NOT_RESOLVED', 'unreachable', 'ERR_NAME_NOT_RESOLVED'],
    ["Attempted to redirect, but redirect policy was 'error'", 'redirect', undefined],
    ['Redirect was cancelled', 'redirect', undefined],
    ['something else', 'unreachable', undefined],
  ])('%s is %s', (message, kind, detail) => {
    expect(classifyNetworkError(new Error(message))).toMatchObject({ kind, detail })
  })

  it('never carries the raw error text, only the checked name', async () => {
    const guarded = createGuardedFetch(any, () => () => {
      throw new Error(`${OFFICIAL}?key=${SECRET} net::ERR_CERT_DATE_INVALID Bearer ${SECRET}`)
    })
    const failure = await rejected(guarded(OFFICIAL))
    expect(failure).toMatchObject({ kind: 'certificate', detail: 'ERR_CERT_DATE_INVALID' })
    expect(JSON.stringify(failure)).not.toContain(SECRET)
    expect(String(failure)).not.toContain(SECRET)
    expect((failure as Error).stack).not.toContain(SECRET)
    expect((failure as Error).cause).toBeUndefined()
  })

  it('a detail that is not Chromium-shaped is dropped', () => {
    expect(classifyNetworkError(new Error(`net::ERR_x${SECRET}`)).detail).toBeUndefined()
  })

  it("treats the proxy's own 407 as a proxy failure, never as the provider's answer", async () => {
    let cancelled = false
    const body = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    const { fetch, calls } = over(
      () => new Response(body, { status: 407, headers: { 'proxy-authenticate': 'Basic' } }),
    )
    expect(await rejected(fetch(OFFICIAL))).toMatchObject({ kind: 'proxy', detail: 'HTTP 407' })
    expect(cancelled).toBe(true)
    expect(calls[0]?.init.signal?.aborted).toBe(true)
  })

  it.each([
    [
      'proxy',
      'ERR_TUNNEL_CONNECTION_FAILED',
      /through your network's proxy or security software\./,
    ],
    ['certificate', 'ERR_CERT_AUTHORITY_INVALID', /certificate is not trusted\./],
    ['offline', 'ERR_INTERNET_DISCONNECTED', /appears to be offline\./],
  ] as const)('%s has its own message and a Details line', (kind, detail, text) => {
    const message = networkErrorMessage('Claude', new NetworkFailure(kind, detail), 'generic')
    expect(message).toMatch(text)
    expect(message).toContain('Could not reach Claude')
    expect(message).toMatch(new RegExp(` Details: ${detail}\\.$`))
  })

  it('other failures keep the caller’s wording, with a Details line when there is a name', () => {
    expect(
      networkErrorMessage(
        'X',
        new NetworkFailure('unreachable', 'ERR_CONNECTION_RESET'),
        'generic.',
      ),
    ).toBe('generic. Details: ERR_CONNECTION_RESET.')
    expect(networkErrorMessage('X', new TypeError(`fetch failed ${SECRET}`), 'generic.')).toBe(
      'generic.',
    )
  })
})

describe('the response body', () => {
  /** A body that stays open like a long stream, reporting when it is cancelled. */
  function openBody() {
    const state = { cancelled: false }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first'))
      },
      cancel() {
        state.cancelled = true
      },
    })
    return { state, body }
  }

  it('hands chunks through as they arrive', async () => {
    const { body } = openBody()
    const { fetch } = over(() => new Response(body, { status: 201, headers: { a: 'b' } }))
    const response = await fetch(OFFICIAL)
    expect(response.status).toBe(201)
    expect(response.headers.get('a')).toBe('b')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('first')
    await reader.cancel()
  })

  it('keeps a bodiless response bodiless', async () => {
    const { fetch } = over(() => new Response(null, { status: 204 }))
    const response = await fetch(OFFICIAL)
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('stops the request when the reader cancels: Electron does not, on its own', async () => {
    const { state, body } = openBody()
    const { fetch, calls } = over(() => new Response(body))
    const response = await fetch(OFFICIAL)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    expect(calls[0]?.init.signal?.aborted).toBe(false)
    await reader.cancel()
    expect(calls[0]?.init.signal?.aborted).toBe(true)
    expect(state.cancelled).toBe(true)
  })

  it('a size limit stops the request', async () => {
    const { fetch, calls } = over(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024))
            },
          }),
        ),
    )
    const response = await fetch(OFFICIAL)
    const read = await readText(response.body as ReadableStream<Uint8Array>, 4096)
    expect(read).toEqual({ ok: false, reason: 'too_large' })
    expect(calls[0]?.init.signal?.aborted).toBe(true)
  })

  it('a cancelled request stays an abort, before and after the response', async () => {
    const controller = new AbortController()
    const reason = new DOMException('stopped', 'AbortError')
    const before = createGuardedFetch(
      any,
      () => (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(reason)
          })
        }),
    )
    const pending = before(OFFICIAL, { signal: controller.signal })
    controller.abort(reason)
    expect(await rejected(pending)).toBe(reason)

    const stop = new AbortController()
    const { fetch, calls } = over(
      (init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              init.signal?.addEventListener('abort', () => {
                c.error(reason)
              })
            },
          }),
        ),
    )
    const response = await fetch(OFFICIAL, { signal: stop.signal })
    const reading = (response.body as ReadableStream<Uint8Array>).getReader().read()
    stop.abort(reason)
    expect(await rejected(reading)).toBe(reason)
    expect(calls[0]?.init.signal?.aborted).toBe(true)
  })

  it('a connection lost mid-stream is classified, not raw', async () => {
    const { fetch } = over(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              throw new Error(`net::ERR_CONNECTION_RESET ${SECRET}`)
            },
          }),
        ),
    )
    const response = await fetch(OFFICIAL)
    const failure = await rejected((response.body as ReadableStream<Uint8Array>).getReader().read())
    expect(failure).toMatchObject({ kind: 'unreachable', detail: 'ERR_CONNECTION_RESET' })
    expect(String(failure)).not.toContain(SECRET)
  })
})

/** The real clients with no fetch injected, as the app builds them. */
describe('the clients use the network layer', () => {
  /** Stands in for what reaches Electron's transport (see vitest-setup.ts). */
  function network(respond: (url: string, init: RequestInit) => Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return respond(url, init)
    })
    return calls
  }
  const failing = (message: string) => () => Promise.reject(new Error(message))
  const CLAUDE_PARAMS = {
    model: 'claude-test',
    max_tokens: 1,
    messages: [{ role: 'user' as const, content: 'hi' }],
  }

  it('Claude: goes through cloudFetch, to the fixed address, whatever the environment says', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example')
    const calls = network(() =>
      Promise.resolve(new Response('', { headers: { 'content-type': 'text/event-stream' } })),
    )
    const stream = createClaudeClient(SECRET).messages.stream(CLAUDE_PARAMS, {
      signal: new AbortController().signal,
    })
    // An empty stream is an error; only the request matters here.
    await rejected(stream.finalMessage())
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0]?.init).toMatchObject({ credentials: 'omit', cache: 'no-store' })
  })

  it('Claude: a proxy failure has its own message; nothing of the key', async () => {
    const calls = network(failing('net::ERR_TUNNEL_CONNECTION_FAILED'))
    const stream = createClaudeClient(SECRET).messages.stream(CLAUDE_PARAMS, {
      signal: new AbortController().signal,
    })
    const event = apiErrorEvent(await rejected(stream.finalMessage()))
    expect(event).toEqual({
      type: 'error',
      code: 'network',
      message:
        "Could not reach Claude through your network's proxy or security software. Details: ERR_TUNNEL_CONNECTION_FAILED.",
    })
    // The SDK's two retries, then the error; the refused request is what they repeat.
    expect(calls).toHaveLength(3)
  }, 15_000)

  it('Claude: a redirect is refused and not followed', async () => {
    const calls = network(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
      ),
    )
    const stream = createClaudeClient(SECRET).messages.stream(CLAUDE_PARAMS, {
      signal: new AbortController().signal,
    })
    const event = apiErrorEvent(await rejected(stream.finalMessage()))
    expect(event.message).toBe('Claude answered with a redirect, which is not followed.')
    expect(new Set(calls.map((call) => call.url))).toEqual(
      new Set(['https://api.anthropic.com/v1/messages']),
    )
  }, 15_000)

  it('Gemini: a certificate failure has its own message', async () => {
    const calls = network(failing('net::ERR_CERT_AUTHORITY_INVALID'))
    const stream = createGeminiClient({ apiKey: SECRET, model: 'gemini-test' }).messages.stream(
      CLAUDE_PARAMS,
      { signal: new AbortController().signal },
    )
    const event = geminiErrorEvent(await rejected(stream.finalMessage()))
    expect(event.code).toBe('network')
    expect(event.message).toContain("through your network's proxy or security software")
    expect(event.message).toContain('Details: ERR_CERT_AUTHORITY_INVALID.')
    expect(calls[0]?.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//)
    expect(calls[0]?.url).not.toContain(SECRET)
    expect(JSON.stringify(event)).not.toContain(SECRET)
  })

  it('Gemini: listing models uses the network layer too, with the key only in the header', async () => {
    const calls = network(failing('net::ERR_PROXY_CONNECTION_FAILED'))
    expect(await rejected(listGeminiModels(SECRET))).toMatchObject({
      message: expect.stringContaining('ERR_PROXY_CONNECTION_FAILED') as string,
    })
    expect(calls[0]?.init).toMatchObject({ credentials: 'omit' })
    expect(calls[0]?.url).not.toContain(SECRET)
  })

  it('Gemini: a refused redirect is reported as one', async () => {
    network(() =>
      Promise.resolve(new Response(null, { status: 307, headers: { location: 'https://x.test' } })),
    )
    const error = await rejected(
      geminiFetch(cloudFetch, '/v1beta/models', SECRET, {
        method: 'GET',
        signal: new AbortController().signal,
      }),
    )
    expect(error).toMatchObject({
      code: 'network',
      message: 'Gemini answered with a redirect, which is not followed.',
    })
  })

  describe.each([
    ['openai', 'https://api.openai.com/v1', 'OpenAI'],
    ['openrouter', 'https://openrouter.ai/api/v1', 'OpenRouter'],
  ] as const)('%s', (flavor, baseUrl, label) => {
    const request = () =>
      connect({ flavor, baseUrl, apiKey: SECRET }).request('models', {
        method: 'GET',
        accept: 'application/json',
      })

    it('a proxy failure has its own message', async () => {
      network(failing('net::ERR_PROXY_CONNECTION_FAILED'))
      const error = await rejected(request())
      expect(error).toMatchObject({
        code: 'network',
        message: `Could not reach ${label} through your network's proxy or security software. Details: ERR_PROXY_CONNECTION_FAILED.`,
      })
    })

    it('a redirect keeps its message and sends nothing onward', async () => {
      const calls = network(() =>
        Promise.resolve(
          new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }),
        ),
      )
      expect(await rejected(request())).toMatchObject({
        code: 'api',
        message: `${label} answered with a redirect, which is not followed. Check the base URL.`,
      })
      expect(calls).toHaveLength(1)
    })
  })

  it('a local server goes through localFetch, and its redirect is refused', async () => {
    const server = await fakeServer()
    try {
      server.reply((_req, res) => {
        res.writeHead(302, { location: `${server.origin}/onward` }).end()
      })
      const error = await rejected(
        connect({ flavor: 'ollama', baseUrl: server.baseUrl }).request('models', {
          method: 'GET',
          accept: 'application/json',
        }),
      )
      expect(error).toMatchObject({
        message: 'Ollama answered with a redirect, which is not followed. Check the base URL.',
      })
      expect(server.requests.map((request) => request.path)).toEqual(['/v1/models'])
    } finally {
      await server.close()
    }
  })

  it('ChatGPT sign-in: proxy and certificate failures are named, transient and carry no URL', async () => {
    const form = { method: 'POST' as const, form: { code: SECRET } }
    const url = 'https://auth.openai.com/api/accounts/oauth/token'
    network(failing('net::ERR_TUNNEL_CONNECTION_FAILED'))
    const proxy = await rejected(send(cloudFetch, url, form))
    expect(proxy).toBeInstanceOf(ChatgptAuthError)
    expect(proxy).toMatchObject({
      code: 'proxy',
      transient: true,
      message:
        "Could not reach OpenAI through your network's proxy or security software. Details: ERR_TUNNEL_CONNECTION_FAILED.",
    })
    network(failing('net::ERR_CERT_AUTHORITY_INVALID'))
    const certificate = await rejected(send(cloudFetch, url, form))
    expect(certificate).toMatchObject({ code: 'certificate', transient: true })
    expect(String(certificate)).not.toContain(SECRET)
    expect(String(certificate)).not.toContain(url)
    // A run that needed a refresh reports a network problem, not an expired sign-in.
    expect(authFailure(proxy as ChatgptAuthError).code).toBe('network')
    expect(authFailure(certificate as ChatgptAuthError).code).toBe('network')
  })

  it("ChatGPT sign-in: the app's service goes through cloudFetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'network-auth-'))
    try {
      const calls = network(failing('net::ERR_PROXY_CONNECTION_FAILED'))
      const auth = createChatgptAuth({
        keys: createKeyStore({
          userDataPath: dir,
          safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (value) => Buffer.from(value),
            decryptString: (data) => data.toString(),
          },
        }),
        settings: { chatgptAuth: null, setChatgptAuth: () => Promise.resolve() },
      })
      const error = await rejected(
        auth.login({
          signal: new AbortController().signal,
          openUrl: () => Promise.resolve(),
        }),
      )
      expect(error).toMatchObject({ code: 'proxy' })
      expect(calls[0]?.url).toBe('https://auth.openai.com/.well-known/openid-configuration')
      expect(calls[0]?.init).toMatchObject({ credentials: 'omit' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ChatGPT sign-in: any other failure keeps the plain network message', async () => {
    network(failing('net::ERR_CONNECTION_RESET'))
    expect(
      await rejected(send(cloudFetch, 'https://auth.openai.com/x', { method: 'GET' })),
    ).toMatchObject({
      code: 'network',
    })
  })

  it('ChatGPT sign-in: a refused redirect stops at the first host', async () => {
    const calls = network(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://x.test' } })),
    )
    expect(
      await rejected(send(cloudFetch, 'https://auth.openai.com/x', { method: 'GET' })),
    ).toMatchObject({
      code: 'network',
    })
    expect(calls).toHaveLength(1)
  })
})
