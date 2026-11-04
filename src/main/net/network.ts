/**
 * The one way main reaches a model over the network. Cloud requests go through Chromium's
 * network stack, so they follow the system proxy and trust the system's certificates;
 * requests to a local server (Ollama, LM Studio) go through a session that never uses a
 * proxy. See docs/network.md.
 *
 * Every request here refuses redirects, sends no cookies or stored credentials, and goes
 * only to an address this file allows. There is no fallback to Node's fetch: before
 * installNetworkTransports runs, a request fails.
 */

/** Sends one request. Electron's Session.fetch in the app; see electron-transports.ts. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>

export interface NetworkTransports {
  /** The system's proxy and certificates. */
  cloud: Transport
  /** Never a proxy. */
  local: Transport
}

export type NetworkFailureKind =
  /** The proxy refused, wanted a sign-in, or could not be reached. */
  | 'proxy'
  /** The connection's certificate was not trusted, often TLS inspection. */
  | 'certificate'
  | 'offline'
  /** The server answered with a redirect; nothing was sent onward. */
  | 'redirect'
  /** Any other transport failure. */
  | 'unreachable'
  /** The address is not one this app sends requests to; nothing was sent. */
  | 'refused'
  /** The network layer is not installed yet; nothing was sent. */
  | 'not-ready'

/** Fixed text and a pattern-checked detail only: a raw error can carry a URL. No cause is kept. */
export class NetworkFailure extends Error {
  override readonly name = 'NetworkFailure'
  constructor(
    readonly kind: NetworkFailureKind,
    /** Chromium's error name (ERR_...) or "HTTP 407", safe to show. */
    readonly detail?: string,
  ) {
    super(`Network request failed (${kind}).`)
  }
}

/** Where cloud requests may go: each provider's fixed official host, on the default port. */
export const OFFICIAL_HOSTS: ReadonlySet<string> = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'auth.openai.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
])
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost'])

export const isOfficialUrl = (url: URL): boolean =>
  url.protocol === 'https:' &&
  url.port === '' &&
  !url.username &&
  !url.password &&
  OFFICIAL_HOSTS.has(url.hostname)

export const isLoopbackUrl = (url: URL): boolean =>
  url.protocol === 'http:' && !url.username && !url.password && LOOPBACK_HOSTS.has(url.hostname)

// Chromium's names from net/base/net_error_list.h.
const PROXY_ERROR =
  /^ERR_(?:PROXY_|TUNNEL_CONNECTION_FAILED$|MANDATORY_PROXY_CONFIGURATION_FAILED$|SOCKS_|HTTPS_PROXY_|PAC_|UNEXPECTED_PROXY_AUTH$|NO_SUPPORTED_PROXIES$|NETWORK_ACCESS_DENIED$)/
const CERTIFICATE_ERROR =
  /^ERR_(?:CERT_|CERTIFICATE_|SSL_|TLS13_|BAD_SSL_CLIENT_AUTH_CERT$|ECH_|WRONG_VERSION_ON_EARLY_DATA$)/
const OFFLINE_ERROR = /^ERR_INTERNET_DISCONNECTED$/
const NET_ERROR = /\bnet::(ERR_[A-Z0-9_]{1,80})\b/
// ClientRequest's own wording when redirect is 'error' or 'manual'; it never resolves with a 3xx.
const REDIRECT_ERROR = /^(?:Attempted to redirect|Redirect was cancelled)/

/** What went wrong with a request, from whatever its transport threw. */
export function classifyNetworkError(error: unknown): NetworkFailure {
  if (error instanceof NetworkFailure) return error
  const message = error instanceof Error ? error.message : ''
  if (REDIRECT_ERROR.test(message)) return new NetworkFailure('redirect')
  const code = NET_ERROR.exec(message)?.[1]
  if (code === undefined) return new NetworkFailure('unreachable')
  if (PROXY_ERROR.test(code)) return new NetworkFailure('proxy', code)
  if (CERTIFICATE_ERROR.test(code)) return new NetworkFailure('certificate', code)
  if (OFFLINE_ERROR.test(code)) return new NetworkFailure('offline', code)
  return new NetworkFailure('unreachable', code)
}

/** The NetworkFailure in an error or its cause (the Anthropic SDK wraps what fetch threw). */
export function networkFailureIn(error: unknown): NetworkFailure | undefined {
  if (error instanceof NetworkFailure) return error
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof NetworkFailure ? cause : undefined
}

const detailLine = (failure: NetworkFailure): string =>
  failure.detail ? ` Details: ${failure.detail}.` : ''

/**
 * The app-written message for a failed request, or `fallback` when the error did not come
 * from this layer. `provider` is the name the user knows.
 */
export function networkErrorMessage(provider: string, error: unknown, fallback: string): string {
  const failure = networkFailureIn(error)
  if (!failure) return fallback
  const details = detailLine(failure)
  switch (failure.kind) {
    case 'proxy':
      return `Could not reach ${provider} through your network's proxy or security software.${details}`
    case 'certificate':
      return `Could not reach ${provider} through your network's proxy or security software: the connection's certificate is not trusted.${details}`
    case 'offline':
      return `Could not reach ${provider}: this computer appears to be offline.${details}`
    case 'redirect':
      return `${provider} answered with a redirect, which is not followed.`
    case 'refused':
      return `Could not reach ${provider}: the app does not send requests to that address.`
    case 'not-ready':
      return `Could not reach ${provider}: the app is still starting. Try again.`
    case 'unreachable':
      return `${fallback}${details}`
  }
}

/**
 * Passes the body through, and stops the request when the reader cancels. Electron's body
 * stream only stops reading on cancel: the request itself carries on until aborted.
 */
function guardedBody(
  body: ReadableStream<Uint8Array>,
  isAborted: () => boolean,
  stop: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let next: Awaited<ReturnType<typeof reader.read>>
        try {
          next = await reader.read()
        } catch (error) {
          throw isAborted() ? error : classifyNetworkError(error)
        }
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      },
      async cancel(reason) {
        stop()
        await reader.cancel(reason).catch(() => {})
      },
    },
    // Read only when asked, so a reader's size limit stops what is read.
    { highWaterMark: 0 },
  )
}

/** A fetch limited to the addresses `allow` accepts, over the transport `current` gives. */
export function createGuardedFetch(
  allow: (url: URL) => boolean,
  current: () => Transport | undefined,
): typeof fetch {
  return async (input, init = {}) => {
    // A Request carries its own redirect and credentials settings, which init could not override.
    if (typeof input !== 'string' && !(input instanceof URL)) throw new NetworkFailure('refused')
    let url: URL
    try {
      url = new URL(input)
    } catch {
      throw new NetworkFailure('refused')
    }
    if (!allow(url)) throw new NetworkFailure('refused')
    const transport = current()
    if (!transport) throw new NetworkFailure('not-ready')

    const own = new AbortController()
    const signal = init.signal ? AbortSignal.any([init.signal, own.signal]) : own.signal
    const stop = (): void => {
      own.abort()
    }
    let response: Response
    try {
      response = await transport(url.href, {
        ...init,
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch (error) {
      throw signal.aborted ? error : classifyNetworkError(error)
    }
    // Electron rejects redirects; equivalent transports must not return one to the caller either.
    if (response.status >= 300 && response.status < 400) {
      stop()
      await response.body?.cancel().catch(() => {})
      throw new NetworkFailure('redirect')
    }
    // A proxy's own 407 must never reach the provider's response parser.
    if (response.status === 407) {
      stop()
      await response.body?.cancel().catch(() => {})
      throw new NetworkFailure('proxy', 'HTTP 407')
    }
    if (!response.body) return response
    return new Response(
      guardedBody(response.body, () => signal.aborted, stop),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    )
  }
}

let installed: NetworkTransports | undefined

/** Called once, when the app is ready. A second call throws: nothing can swap the transport. */
export function installNetworkTransports(transports: NetworkTransports): void {
  if (installed) throw new Error('The network transports are already installed.')
  installed = transports
}

/** Requests to a provider's official https host. Everything else is refused. */
export const cloudFetch = createGuardedFetch(isOfficialUrl, () => installed?.cloud)

/** Requests to a server on this computer, never through a proxy. Everything else is refused. */
export const localFetch = createGuardedFetch(isLoopbackUrl, () => installed?.local)
