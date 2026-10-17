import { endpointUrl, FLAVOR_LABELS, resolveBaseUrl, type OpenAICompatFlavor } from './base-url'
import { OpenAICompatError, statusError } from './errors'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ConnectionOptions {
  /** API root, e.g. https://api.openai.com/v1. A bare origin gets the flavor's default path. */
  baseUrl: string
  apiKey?: string
  flavor: OpenAICompatFlavor
  /** For tests. Defaults to the global fetch. */
  fetch?: FetchLike
  /** Abort when no response bytes arrive for this long. Default 120 s. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_ERROR_BODY = 64 * 1024

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
  }>
}

/** Validates the base URL and key up front, so a bad config fails before any request. */
export function connect(options: ConnectionOptions): Connection {
  const { flavor } = options
  const label = FLAVOR_LABELS[flavor]
  const root = resolveBaseUrl(options.baseUrl, flavor)
  const apiKey = options.apiKey?.trim() || undefined
  if (apiKey !== undefined && !/^[\x21-\x7e]{1,1024}$/.test(apiKey))
    throw new OpenAICompatError('authentication', `The ${label} API key has an invalid format.`)
  if (!apiKey && (flavor === 'openai' || flavor === 'openrouter'))
    throw new OpenAICompatError('authentication', `Add a ${label} API key in settings.`)
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
      touch()
      try {
        if (init.signal?.aborted) throw new Error('aborted')
        const headers: Record<string, string> = { Accept: init.accept }
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`
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
          throw statusError(response.status, body, label, response.headers)
        }
        return { response, touch, done, mapError }
      } catch (error) {
        done()
        throw mapError(error)
      }
    },
  }
}

async function readErrorBody(response: Response): Promise<unknown> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < MAX_ERROR_BODY) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    return undefined
  } finally {
    reader.cancel().catch(() => {})
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY))
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { error: { message: text } }
  }
}
