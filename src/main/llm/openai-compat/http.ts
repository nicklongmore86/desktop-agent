import { endpointUrl, FLAVOR_LABELS, resolveBaseUrl, type OpenAICompatFlavor } from './base-url'
import { OpenAICompatError, statusError } from './errors'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
/** True when a value shares a meaningful run with the credential sent on this request. */
export type SecretCheck = (value: string) => boolean
/** Maps a non-2xx response. `isSecret` lets it drop values that echo the credential. */
export type StatusErrorMapper = (
  status: number,
  body: unknown,
  label: string,
  headers?: Headers,
  isSecret?: SecretCheck,
) => OpenAICompatError

export interface ConnectionOptions {
  /** API root, e.g. https://api.openai.com/v1. A bare origin gets the flavor's default path. */
  baseUrl: string
  apiKey?: string
  flavor: OpenAICompatFlavor
  /** For tests. Defaults to the global fetch. */
  fetch?: FetchLike
  /** Abort when no response bytes arrive for this long. Default 120 s. */
  timeoutMs?: number
  /** Read before each request instead of `apiKey`, e.g. an OAuth token that may be refreshed. */
  getAccessToken?: () => Promise<string>
  /** Overrides the flavor's name in error text. */
  label?: string
  /** Overrides how a non-2xx response is mapped. */
  statusError?: StatusErrorMapper
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_ERROR_BODY = 64 * 1024
const KEY_FORMAT = /^[\x21-\x7e]{1,1024}$/
// OAuth access tokens are JWTs, which run longer than API keys.
const TOKEN_FORMAT = /^[\x21-\x7e]{1,16384}$/
/** Shorter runs of a credential are too common to treat as an echo of it. */
const SECRET_RUN = 8

/**
 * True when `value` contains `secret`, or shares any run of SECRET_RUN characters with it,
 * ignoring case (a header value may have been lowercased on the way).
 */
export function sharesSecret(value: string, secret: string | undefined): boolean {
  if (!secret || !value) return false
  const v = value.toLowerCase()
  const s = secret.toLowerCase()
  if (v.includes(s)) return true
  if (s.length < SECRET_RUN) return false
  for (let i = 0; i + SECRET_RUN <= v.length; i++)
    if (s.includes(v.slice(i, i + SECRET_RUN))) return true
  return false
}

export interface Connection {
  label: string
  flavor: OpenAICompatFlavor
  url(endpoint: string): string
  /**
   * Sends one request. Resolves with a 2xx response; maps everything else to an
   * OpenAICompatError. Call `touch()` while reading the body to reset the idle timer
   * and `done()` when finished.
   */
  request(
    endpoint: string,
    init: { method: 'GET' | 'POST'; body?: unknown; accept: string; signal?: AbortSignal },
  ): Promise<{
    response: Response
    touch: () => void
    done: () => void
    mapError: (e: unknown) => Error
    /** Checks a value from the response against the credential this request sent. */
    isSecret: SecretCheck
  }>
}

/** Validates the base URL and key up front, so a bad config fails before any request. */
export function connect(options: ConnectionOptions): Connection {
  const { flavor } = options
  const label = options.label ?? FLAVOR_LABELS[flavor]
  const root = resolveBaseUrl(options.baseUrl, flavor)
  const apiKey = options.apiKey?.trim() || undefined
  const { getAccessToken } = options
  const mapStatus = options.statusError ?? statusError
  if (apiKey !== undefined && !KEY_FORMAT.test(apiKey))
    throw new OpenAICompatError('authentication', `The ${label} API key has an invalid format.`)
  if (!apiKey && !getAccessToken && (flavor === 'openai' || flavor === 'openrouter'))
    throw new OpenAICompatError('authentication', `Add a ${label} API key in settings.`)
  const bearer = async (): Promise<string | undefined> => {
    if (apiKey || !getAccessToken) return apiKey
    let token: string
    try {
      token = (await getAccessToken()).trim()
    } catch (error) {
      if (error instanceof OpenAICompatError) throw error
      // The token source's own error text may carry credentials; never forward it.
      throw new OpenAICompatError('auth_expired', `Sign in to ${label} again.`)
    }
    if (!TOKEN_FORMAT.test(token))
      throw new OpenAICompatError('auth_expired', `The ${label} sign-in is invalid. Sign in again.`)
    return token
  }
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = (endpoint: string): string => endpointUrl(root, endpoint)

  return {
    label,
    flavor,
    url,
    async request(endpoint, init) {
      const timeout = new AbortController()
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const touch = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          timedOut = true
          timeout.abort()
        }, timeoutMs)
      }
      const done = (): void => {
        clearTimeout(timer)
      }
      const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal
      const mapError = (error: unknown): Error => {
        if (init.signal?.aborted)
          return new OpenAICompatError('aborted', `The ${label} request was cancelled.`)
        if (timedOut)
          return new OpenAICompatError('network', `The ${label} request timed out. Try again.`)
        if (error instanceof OpenAICompatError) return error
        // fetch failures (TypeError) carry socket details; never forward them.
        return new OpenAICompatError(
          'network',
          `Could not connect to ${label}. Check that it is running and reachable.`,
        )
      }
      let sent: string | undefined
      const isSecret: SecretCheck = (value) => sharesSecret(value, sent)
      touch()
      try {
        if (init.signal?.aborted) throw new Error('aborted')
        const token = await bearer()
        sent = token
        if (init.signal?.aborted) throw new Error('aborted')
        const headers: Record<string, string> = { Accept: init.accept }
        if (token) headers.Authorization = `Bearer ${token}`
        if (init.body !== undefined) headers['Content-Type'] = 'application/json'
        const response = await doFetch(url(endpoint), {
          method: init.method,
          headers,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal,
          // Never follow redirects: a 3xx could move the key to another host.
          redirect: 'manual',
        })
        touch()
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => {})
          throw new OpenAICompatError(
            'api',
            `${label} answered with a redirect, which is not followed. Check the base URL.`,
            { status: response.status },
          )
        }
        if (!response.ok) {
          const body = await readErrorBody(response)
          throw mapStatus(response.status, body, label, response.headers, isSecret)
        }
        return { response, touch, done, mapError, isSecret }
      } catch (error) {
        done()
        throw mapError(error)
      }
    },
  }
}

async function readErrorBody(response: Response): Promise<unknown> {
  if (!response.body) return undefined
  const read = await readText(response.body, MAX_ERROR_BODY)
  if (!read.ok) return undefined
  try {
    return JSON.parse(read.text) as unknown
  } catch {
    return { error: { message: read.text } }
  }
}

export type ReadText =
  { ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' }

/**
 * Reads a whole body as text. A body longer than `limit` bytes is refused outright, never
 * cut short (a cut body can still parse), and the rest is cancelled. `onBytes` is called
 * per chunk, e.g. to reset an idle timer.
 */
export async function readText(
  body: ReadableStream<Uint8Array>,
  limit: number,
  onBytes?: () => void,
): Promise<ReadText> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onBytes?.()
      size += value.byteLength
      if (size > limit) return { ok: false, reason: 'too_large' }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    reader.cancel().catch(() => {})
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) }
}
