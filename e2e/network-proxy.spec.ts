import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as tcpConnect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The network layer through real Chromium sessions and a local proxy: nothing here leaves the
 * machine. The proxy answers plain http itself and tunnels the official hosts to a local TLS
 * server, so the real clients run to their real addresses.
 *
 * "The system proxy" is the real setting: the environment on Linux, the Internet Settings
 * registry key on Windows. On Windows this changes the machine, so it runs on CI only, where it
 * also installs a test root in the machine's store to play a TLS-inspecting proxy's CA.
 */

const CI_WINDOWS = process.platform === 'win32' && !!process.env['CI']
const SUPPORTED = process.platform === 'linux' || CI_WINDOWS
const KEY = 'sk-test-network-key-0123456789'

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
}

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })

const SSE_CHUNKS = ['one', 'two', 'three', 'four']

/** A forward proxy that is also the origin for plain-http test names. */
class TestProxy {
  readonly requests: Seen[] = []
  readonly connects: string[] = []
  /** Requests whose client went away before the reply finished. */
  readonly closedEarly: string[] = []
  tunnelTo: number | undefined
  private readonly sockets = new Set<Socket>()
  private readonly server = createHttpServer((req, res) => {
    const url = req.url ?? ''
    this.requests.push({ method: req.method ?? '', url, headers: req.headers })
    req.resume()
    res.on('close', () => {
      if (!res.writableFinished) this.closedEarly.push(url)
    })
    const path = new URL(url, 'http://x').pathname
    if (path === '/redirect') {
      res.writeHead(302, { location: 'http://onward.test/stolen' }).end()
    } else if (path === '/needs-sign-in') {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="corp"' }).end('sign in')
    } else if (path === '/set-cookie') {
      res.writeHead(200, { 'set-cookie': 'tracked=1; Path=/' }).end('ok')
    } else if (path === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let index = 0
      const timer = setInterval(() => {
        const chunk = SSE_CHUNKS[index++]
        if (chunk === undefined) {
          clearInterval(timer)
          res.end()
        } else res.write(`data: ${chunk}\n\n`)
      }, 150)
      res.on('close', () => {
        clearInterval(timer)
      })
    } else if (path === '/forever') {
      res.writeHead(200)
      const timer = setInterval(() => res.write('x'.repeat(64 * 1024)), 10)
      res.on('close', () => {
        clearInterval(timer)
      })
    } else res.writeHead(200, { 'content-type': 'text/plain' }).end('via-proxy')
  })
  port = 0

  async start(): Promise<void> {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.server.on('connect', (req, socket: Socket) => {
      socket.on('error', () => {})
      const target = req.url ?? ''
      this.connects.push(target)
      const host = target.split(':')[0] ?? ''
      if (host === 'needs-sign-in.test') {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\nContent-Length: 0\r\n\r\n',
        )
      } else if (host === 'refused.test' || this.tunnelTo === undefined || !isTunnelled(host)) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
      } else {
        const upstream = tcpConnect(this.tunnelTo, '127.0.0.1', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
      }
    })
    this.port = await listen(this.server)
  }
  clear(): void {
    this.requests.length = 0
    this.connects.length = 0
    this.closedEarly.length = 0
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise((resolve) => this.server.close(resolve))
  }
}

const TUNNELLED = [
  'api.anthropic.com',
  'api.openai.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'auth.openai.com',
]
const isTunnelled = (host: string): boolean => TUNNELLED.includes(host)

// --- the system's proxy setting ----------------------------------------------------------------
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
function regSet(name: string, type: string, value: string): void {
  execFileSync('reg', ['add', INTERNET_SETTINGS, '/v', name, '/t', type, '/d', value, '/f'], {
    stdio: 'ignore',
  })
}
function setWindowsProxy(port: number, override = ''): void {
  regSet('ProxyEnable', 'REG_DWORD', '1')
  regSet('ProxyServer', 'REG_SZ', `127.0.0.1:${String(port)}`)
  regSet('ProxyOverride', 'REG_SZ', override)
}
function clearWindowsProxy(): void {
  regSet('ProxyEnable', 'REG_DWORD', '0')
  spawnSync('reg', ['delete', INTERNET_SETTINGS, '/v', 'ProxyServer', '/f'], { stdio: 'ignore' })
  spawnSync('reg', ['delete', INTERNET_SETTINGS, '/v', 'ProxyOverride', '/f'], { stdio: 'ignore' })
}

const PROXY_VARS = /^(?:https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i
/** The environment, cleared of proxy settings and then given `extra`. */
function environment(extra: Record<string, string> = {}): Record<string, string> {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !PROXY_VARS.test(entry[0]),
    ),
  )
  return { ...clean, ...extra }
}
const proxyEnv = (port: number, bypass?: string): Record<string, string> => {
  if (process.platform === 'win32') return {}
  const url = `http://127.0.0.1:${String(port)}`
  return { http_proxy: url, https_proxy: url, ...(bypass ? { no_proxy: bypass } : {}) }
}

// --- the harness --------------------------------------------------------------------------------
interface Failure {
  name?: string
  kind?: string
  detail?: string
  message?: string
}
interface Answer {
  status?: number
  text?: string
  failure?: Failure
}
interface ClientResult {
  deltas: string[]
  text?: string
  event?: { code: string; message: string }
}
type Through = 'any' | 'cloud' | 'local' | 'node'

class Harness {
  constructor(readonly app: ElectronApplication) {}
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.app.evaluate(
      async (_electron, [name, values]) => {
        const api = (globalThis as unknown as { network: Record<string, (...v: unknown[]) => T> })
          .network
        // The harness installs `network` once the app is ready.
        const fn = api[name] as (...v: unknown[]) => T
        return await fn(...values)
      },
      [method, args] as const,
    )
  }
  answer = (through: Through, url: string, init: RequestInit = {}) =>
    this.call<Answer>('answer', through, url, init)
  stream = (through: Through, url: string) =>
    this.call<{ at: number; text: string }[]>('stream', through, url)
  abortAfterFirstChunk = (through: Through, url: string) =>
    this.call<{ ended?: boolean; failure?: Failure }>('abortAfterFirstChunk', through, url)
  cancelAfterFirstChunk = (through: Through, url: string) =>
    this.call<unknown>('cancelAfterFirstChunk', through, url)
  beforeReady = () => this.call<Failure & { sent?: boolean }>('beforeReady')
  logins = () => this.call<string[]>('logins')
  setDefaultSessionCookie = (url: string) => this.call<unknown>('setDefaultSessionCookie', url)
  cloudSessionCookies = () => this.call<unknown[]>('cloudSessionCookies')
  resolveProxy = (partition: string, url: string) =>
    this.call<string>('resolveProxy', partition, url)
  claude = (key: string) => this.call<ClientResult>('claude', key)
  gemini = (key: string) => this.call<ClientResult>('gemini', key)
  compat = (options: Record<string, unknown>) => this.call<ClientResult>('compat', options)
  localModels = (baseUrl: string) =>
    this.call<{ models?: { id: string }[]; failure?: Failure }>('localModels', baseUrl)
}

async function launch(env: Record<string, string>): Promise<Harness> {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/network-main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env,
  })
  await app.evaluate(async () => {
    while (!(globalThis as unknown as { network?: unknown }).network)
      await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return new Harness(app)
}

/** The renderer's API, as far as these tests use it. */
interface DesktopApi {
  connections: {
    setBaseUrl: (id: string, baseUrl: string) => Promise<unknown>
    status: (id: string) => Promise<unknown>
  }
  apiKey: { set: (key: string, id: string) => Promise<unknown> }
}

/** Repeats until `check` passes, for what the other end only sees a moment later. */
const eventually = (check: () => void): Promise<void> =>
  expect(check).toPass({ timeout: 5_000, intervals: [50, 100, 200] })

// --- a certificate authority and the provider it vouches for -----------------------------------
function openssl(): string | undefined {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL\\bin\\openssl.exe',
  ]
  return candidates.find(
    (file) =>
      (file === 'openssl' || existsSync(file)) &&
      spawnSync(file, ['version'], { stdio: 'ignore' }).status === 0,
  )
}

interface Certificates {
  ca: string
  key: Buffer
  cert: Buffer
  dir: string
}
/** A throwaway root and a leaf for the official hosts; never committed, gone after the run. */
function makeCertificates(tool: string): Certificates {
  const dir = mkdtempSync(join(tmpdir(), 'network-proxy-ca-'))
  const file = (name: string): string => join(dir, name)
  const run = (...args: string[]) => {
    execFileSync(tool, args, { stdio: 'ignore' })
  }
  writeFileSync(
    file('ca.cnf'),
    '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=Desktop Agent Test Inspecting CA\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
  )
  run(
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', file('ca.key'), '-out', file('ca.crt'), '-config', file('ca.cnf'),
  ) // prettier-ignore
  writeFileSync(
    file('leaf.ext'),
    `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${TUNNELLED.map((host) => `DNS:${host}`).join(',')}\n`,
  )
  run(
    'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.openai.com',
    '-keyout', file('leaf.key'), '-out', file('leaf.csr'),
  ) // prettier-ignore
  run(
    'x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'),
    '-CAcreateserial', '-days', '2', '-extfile', file('leaf.ext'), '-out', file('leaf.crt'),
  ) // prettier-ignore
  return {
    ca: file('ca.crt'),
    key: readFileSync(file('leaf.key')),
    cert: readFileSync(file('leaf.crt')),
    dir,
  }
}

/** Answers as each provider would for a one-line reply, recording the credential it was sent. */
async function fakeProviders(certificates: Certificates) {
  const seen: Seen[] = []
  const server = createHttpsServer(
    { key: certificates.key, cert: certificates.cert },
    (req, res) => {
      seen.push({
        method: req.method ?? '',
        url: `${req.headers.host ?? ''}${req.url ?? ''}`,
        headers: req.headers,
      })
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const host = req.headers.host ?? ''
        const event = (name: string | null, data: unknown) => {
          res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
        }
        if (host.startsWith('api.anthropic')) {
          event('message_start', {
            type: 'message_start',
            message: {
              id: 'm', type: 'message', role: 'assistant', model: 'm', content: [],
              stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }, // prettier-ignore
          })
          event('content_block_start', {
            type: 'content_block_start', index: 0,
            content_block: { type: 'text', text: '' },
          }) // prettier-ignore
          event('content_block_delta', {
            type: 'content_block_delta', index: 0,
            delta: { type: 'text_delta', text: 'through the proxy' },
          }) // prettier-ignore
          event('content_block_stop', { type: 'content_block_stop', index: 0 })
          event('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          })
          event('message_stop', { type: 'message_stop' })
        } else if (host.startsWith('generativelanguage')) {
          event(null, {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'through the proxy' }] },
                finishReason: 'STOP',
              },
            ],
          })
        } else {
          event(null, {
            id: 'c', object: 'chat.completion.chunk', model: 'm',
            choices: [{ index: 0, delta: { content: 'through the proxy' }, finish_reason: null }],
          }) // prettier-ignore
          event(null, {
            id: 'c', object: 'chat.completion.chunk', model: 'm',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) // prettier-ignore
          res.write('data: [DONE]\n\n')
        }
        res.end()
      })
    },
  )
  const port = await listen(server)
  return {
    port,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}

const closedPort = async (): Promise<number> => {
  const server = createHttpServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

test.describe('the network layer in real Electron', () => {
  test.skip(!SUPPORTED, 'Sets the system proxy: Linux, or Windows on CI only.')
  test.setTimeout(120_000)

  const proxy = new TestProxy()
  let harness: Harness
  let certificates: Certificates | undefined
  let providers: Awaited<ReturnType<typeof fakeProviders>> | undefined

  test.beforeAll(async () => {
    await proxy.start()
    const tool = openssl()
    if (tool) {
      certificates = makeCertificates(tool)
      providers = await fakeProviders(certificates)
      proxy.tunnelTo = providers.port
    }
    if (CI_WINDOWS) setWindowsProxy(proxy.port)
    harness = await launch(environment(proxyEnv(proxy.port)))
  })
  test.afterAll(async () => {
    // Unset if launching failed: the system proxy must still be cleared below.
    await (harness as Harness | undefined)?.app.close()
    if (CI_WINDOWS) clearWindowsProxy()
    await providers?.close()
    await proxy.close()
    if (certificates) rmSync(certificates.dir, { recursive: true, force: true })
  })
  test.beforeEach(() => {
    proxy.clear()
  })

  test('a request made before the app is ready fails, sending nothing', async () => {
    expect(await harness.beforeReady()).toMatchObject({ name: 'NetworkFailure', kind: 'not-ready' })
  })

  test('the cloud session follows the system proxy; the local session uses none', async () => {
    const via = `PROXY 127.0.0.1:${String(proxy.port)}`
    expect(await harness.resolveProxy('network-cloud', 'https://api.openai.com/')).toBe(via)
    expect(await harness.resolveProxy('network-local', 'https://api.openai.com/')).toBe('DIRECT')
    expect(await harness.resolveProxy('network-local', 'http://127.0.0.1:11434/')).toBe('DIRECT')
  })

  test('a cloud request goes through the proxy, with its headers and no cookies', async () => {
    await harness.setDefaultSessionCookie('http://cloud.test/')
    const reply = await harness.answer('any', 'http://cloud.test/hello', {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    })
    expect(reply).toEqual({ status: 200, text: 'via-proxy' })
    const [request] = proxy.requests
    expect(request).toMatchObject({ method: 'POST', url: 'http://cloud.test/hello' })
    expect(request?.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(request?.headers['cookie']).toBeUndefined()
    expect(request?.headers['content-length']).toBe('7')
    expect(request?.headers['user-agent']).toMatch(/^DesktopAgent\//)
    expect(request?.headers['origin']).toBeUndefined()
  })

  test('a cookie a server sets is neither kept nor sent back', async () => {
    await harness.answer('any', 'http://cloud.test/set-cookie')
    await harness.answer('any', 'http://cloud.test/after')
    expect(proxy.requests.map((request) => request.headers['cookie'])).toEqual([
      undefined,
      undefined,
    ])
    expect(await harness.cloudSessionCookies()).toEqual([])
  })

  for (const redirect of ['error', 'manual', 'follow'] as const)
    test(`a redirect is refused and the key goes nowhere (caller asks for ${redirect})`, async () => {
      const reply = await harness.answer('any', 'http://cloud.test/redirect', {
        redirect,
        headers: { authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
      })
      expect(reply.failure).toMatchObject({ name: 'NetworkFailure', kind: 'redirect' })
      expect(proxy.requests.map((request) => request.url)).toEqual(['http://cloud.test/redirect'])
    })

  test('a stream arrives chunk by chunk', async () => {
    const chunks = await harness.stream('any', 'http://cloud.test/stream')
    const text = chunks.map((chunk) => chunk.text).join('')
    expect(text).toBe(SSE_CHUNKS.map((chunk) => `data: ${chunk}\n\n`).join(''))
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    // Not held back and delivered at the end: the server writes every 150 ms.
    expect((chunks.at(-1)?.at ?? 0) - (chunks[0]?.at ?? 0)).toBeGreaterThan(200)
  })

  test('Stop ends the read as an abort and closes the connection', async () => {
    const result = await harness.abortAfterFirstChunk('any', 'http://cloud.test/stream')
    expect(result.ended).toBeUndefined()
    expect(result.failure?.name).toBe('AbortError')
    await eventually(() => {
      expect(proxy.closedEarly).toContain('http://cloud.test/stream')
    })
  })

  test('a reader that stops, as a size limit does, closes the connection', async () => {
    await harness.cancelAfterFirstChunk('any', 'http://cloud.test/forever')
    await eventually(() => {
      expect(proxy.closedEarly).toContain('http://cloud.test/forever')
    })
  })

  test('a proxy that asks for a sign-in gets no dialog and a clear failure', async () => {
    const plain = await harness.answer('any', 'http://cloud.test/needs-sign-in')
    expect(plain.failure).toMatchObject({ kind: 'proxy', detail: 'HTTP 407' })
    const tunnel = await harness.answer('any', 'https://needs-sign-in.test/')
    expect(tunnel.failure?.kind).toBe('proxy')
    expect(proxy.connects).toContain('needs-sign-in.test:443')
    expect(await harness.logins()).toEqual([])
    for (const request of proxy.requests)
      expect(request.headers['proxy-authorization']).toBeUndefined()
  })

  test('a proxy that refuses the tunnel is a proxy failure', async () => {
    const reply = await harness.answer('any', 'https://refused.test/')
    expect(reply.failure).toMatchObject({ kind: 'proxy', detail: 'ERR_TUNNEL_CONNECTION_FAILED' })
  })

  test('only official hosts are reachable, whatever the proxy would allow', async () => {
    const reply = await harness.answer('cloud', 'https://evil.test/v1')
    expect(reply.failure).toMatchObject({ kind: 'refused' })
    expect(proxy.connects).not.toContain('evil.test:443')
  })

  test('the real clients reach their official hosts through the proxy', async () => {
    test.skip(!certificates, 'Needs openssl to make the TLS server its certificate.')
    const runs: [string, string, () => Promise<ClientResult>][] = [
      ['Claude', 'api.anthropic.com:443', () => harness.claude(KEY)],
      ['Gemini', 'generativelanguage.googleapis.com:443', () => harness.gemini(KEY)],
      [
        'OpenAI',
        'api.openai.com:443',
        () =>
          harness.compat({ flavor: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY }),
      ],
    ]
    // The test root is not trusted yet, so every one stops at the certificate.
    for (const [label, host, run] of runs) {
      const result = await run()
      expect(proxy.connects).toContain(host)
      expect(result.event?.code).toBe('network')
      expect(result.event?.message).toContain(
        `Could not reach ${label} through your network's proxy or security software`,
      )
      expect(result.event?.message).toContain('Details: ERR_CERT_AUTHORITY_INVALID.')
      expect(JSON.stringify(result)).not.toContain(KEY)
    }
    expect(providers?.seen).toEqual([])
  })

  test.describe('with the inspecting root in the Windows store', () => {
    test.skip(!CI_WINDOWS, 'Installs a root certificate: Windows on CI only.')
    let trusting: Harness

    test.beforeAll(() => {
      execFileSync('certutil', ['-addstore', '-f', 'Root', (certificates as Certificates).ca], {
        stdio: 'ignore',
      })
    })
    test.beforeEach(async () => {
      trusting = await launch(environment())
      if (providers) providers.seen.length = 0
    })
    test.afterEach(async () => {
      await trusting.app.close()
    })
    test.afterAll(() => {
      spawnSync('certutil', ['-delstore', 'Root', 'Desktop Agent Test Inspecting CA'], {
        stdio: 'ignore',
      })
    })

    test('Claude, Gemini and OpenAI all work, with keys only in headers', async () => {
      const claude = await trusting.claude(KEY)
      expect(claude.event).toBeUndefined()
      expect(claude.text).toBe('through the proxy')
      expect(claude.deltas).toEqual(['through the proxy'])

      const gemini = await trusting.gemini(KEY)
      expect(gemini.event).toBeUndefined()
      expect(gemini.text).toBe('through the proxy')

      const openai = await trusting.compat({
        flavor: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: KEY,
      })
      expect(openai.event).toBeUndefined()
      expect(openai.text).toBe('through the proxy')

      const byHost = (prefix: string) =>
        providers?.seen.find((request) => request.url.startsWith(prefix))
      expect(byHost('api.anthropic.com')?.headers['x-api-key']).toBe(KEY)
      expect(byHost('generativelanguage.googleapis.com')?.headers['x-goog-api-key']).toBe(KEY)
      expect(byHost('api.openai.com')?.headers['authorization']).toBe(`Bearer ${KEY}`)
      for (const request of providers?.seen ?? []) {
        expect(request.url).not.toContain(KEY)
        expect(request.headers['cookie']).toBeUndefined()
      }
    })
  })
})

test.describe('local servers and the proxy', () => {
  test.skip(!SUPPORTED, 'Sets the system proxy: Linux, or Windows on CI only.')
  test.setTimeout(120_000)

  const proxy = new TestProxy()
  const hits: string[] = []
  let local: Server
  let origin = ''
  let open: Harness | undefined

  test.beforeAll(async () => {
    await proxy.start()
    local = createHttpServer((req, res) => {
      hits.push(req.url ?? '')
      req.resume()
      req.on('end', () => {
        if (req.url?.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-model' }] }))
        } else if (req.url?.endsWith('/redirect')) {
          res.writeHead(302, { location: '/onward' }).end()
        } else if (req.url?.endsWith('/chat/completions')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(
            `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'local reply' }, finish_reason: 'stop' }] })}\n\n`,
          )
          res.end('data: [DONE]\n\n')
        } else res.end('direct')
      })
    })
    origin = `http://127.0.0.1:${String(await listen(local))}`
  })
  test.beforeEach(() => {
    proxy.clear()
    hits.length = 0
  })
  test.afterEach(async () => {
    await open?.app.close()
    open = undefined
    if (CI_WINDOWS) clearWindowsProxy()
  })
  test.afterAll(async () => {
    await new Promise((resolve) => {
      local.close(resolve)
    })
    await proxy.close()
  })

  test('a local server is reached directly under a system proxy, chat included', async () => {
    if (CI_WINDOWS) setWindowsProxy(proxy.port)
    open = await launch(environment(proxyEnv(proxy.port)))
    const baseUrl = `${origin}/v1`
    expect(await open.answer('local', `${origin}/hello`)).toEqual({ status: 200, text: 'direct' })
    expect(await open.localModels(baseUrl)).toMatchObject({ models: [{ id: 'local-model' }] })
    const chat = await open.compat({ flavor: 'ollama', baseUrl })
    expect(chat.event).toBeUndefined()
    expect(chat.text).toBe('local reply')
    expect(hits).toEqual(['/hello', '/v1/models', '/v1/chat/completions'])
    expect(proxy.requests).toEqual([])
    expect(proxy.connects).toEqual([])
  })

  test('a bypass list that turns off the loopback exemption changes nothing for it', async () => {
    if (CI_WINDOWS) setWindowsProxy(proxy.port, '<-loopback>')
    open = await launch(environment(proxyEnv(proxy.port, '<-loopback>')))
    // The cloud session does send loopback to the proxy here, so the setting took effect.
    const url = `${origin}/hello`
    expect(await open.answer('any', url)).toEqual({ status: 200, text: 'via-proxy' })
    expect(proxy.requests.map((request) => request.url)).toEqual([url])
    expect(hits).toEqual([])
    proxy.clear()
    expect(await open.answer('local', url)).toEqual({ status: 200, text: 'direct' })
    expect(hits).toEqual(['/hello'])
    expect(proxy.requests).toEqual([])
    expect(proxy.connects).toEqual([])
  })

  test("Node's proxy support, which would send loopback to the proxy, is not in the path", async () => {
    const url = `http://127.0.0.1:${String(proxy.port)}`
    open = await launch(
      environment({
        ...proxyEnv(proxy.port),
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
      }),
    )
    // Node's fetch does go to the proxy here, which is why local requests do not use it.
    await open.answer('node', `${origin}/plain`)
    expect(proxy.connects.length + proxy.requests.length).toBeGreaterThan(0)
    proxy.clear()
    hits.length = 0
    expect(await open.answer('local', `${origin}/hello`)).toEqual({ status: 200, text: 'direct' })
    expect(hits).toEqual(['/hello'])
    expect(proxy.requests).toEqual([])
    expect(proxy.connects).toEqual([])
  })

  test('a local redirect is refused', async () => {
    open = await launch(environment())
    const reply = await open.answer('local', `${origin}/redirect`)
    expect(reply.failure).toMatchObject({ kind: 'redirect' })
    expect(hits).toEqual(['/redirect'])
  })

  test('only loopback is reachable through the local session', async () => {
    open = await launch(environment())
    const reply = await open.answer('local', 'http://192.168.0.1/')
    expect(reply.failure).toMatchObject({ kind: 'refused' })
  })
})

test.describe('when the proxy is down', () => {
  test.skip(!SUPPORTED, 'Sets the system proxy: Linux, or Windows on CI only.')

  test('the real clients name the proxy', async () => {
    test.setTimeout(120_000)
    const port = await closedPort()
    if (CI_WINDOWS) setWindowsProxy(port)
    const down = await launch(environment(proxyEnv(port)))
    try {
      const result = await down.claude(KEY)
      expect(result.event).toEqual({
        type: 'error',
        code: 'network',
        message:
          "Could not reach Claude through your network's proxy or security software. Details: ERR_PROXY_CONNECTION_FAILED.",
      })
    } finally {
      await down.app.close()
      if (CI_WINDOWS) clearWindowsProxy()
    }
  })
})

test.describe('the real app', () => {
  test.skip(!SUPPORTED, 'Sets the system proxy: Linux, or Windows on CI only.')

  test('main installs the network layer before it needs it', async () => {
    test.setTimeout(120_000)
    const proxy = new TestProxy()
    await proxy.start()
    const seen: Seen[] = []
    const ollama = createHttpServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-model' }] }))
    })
    const port = await listen(ollama)
    const userData = mkdtempSync(join(tmpdir(), 'network-proxy-app-'))
    if (CI_WINDOWS) setWindowsProxy(proxy.port)
    const app = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        `--user-data-dir=${userData}`,
        join(__dirname, 'harness/real-app-main.cjs'),
      ],
      cwd: join(__dirname, '..'),
      env: environment(proxyEnv(proxy.port)),
    })
    try {
      const page = await app.firstWindow()
      await page.waitForFunction(() => 'desktopApi' in window)
      // A local server: reached directly, by Chromium rather than Node.
      const status = await page.evaluate(
        async (origin) => {
          const { connections } = (window as unknown as { desktopApi: DesktopApi }).desktopApi
          await connections.setBaseUrl('ollama', origin)
          return await connections.status('ollama')
        },
        `http://127.0.0.1:${String(port)}`,
      )
      expect(JSON.stringify(status)).not.toContain('not running')
      expect(seen[0]?.url).toBe('/v1/models')
      expect(seen[0]?.headers['user-agent']).toMatch(/^DesktopAgent\//)
      expect(proxy.requests.filter((r) => r.url.includes(String(port)))).toEqual([])

      // A cloud key check, which stays unsaved: through the system proxy, to the official host,
      // with the failure in the app's words all the way to the renderer.
      const saved = await page.evaluate(
        (key) =>
          (window as unknown as { desktopApi: DesktopApi }).desktopApi.apiKey.set(
            key,
            'openai-api',
          ),
        KEY,
      )
      expect(proxy.connects).toContain('api.openai.com:443')
      expect(saved).toEqual({
        saved: false,
        error:
          "Could not reach OpenAI through your network's proxy or security software. Details: ERR_TUNNEL_CONNECTION_FAILED.",
      })
    } finally {
      await app.close()
      if (CI_WINDOWS) clearWindowsProxy()
      ollama.closeAllConnections()
      await new Promise((resolve) => {
        ollama.close(resolve)
      })
      await proxy.close()
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
})
