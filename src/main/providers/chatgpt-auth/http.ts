import { REQUEST_TIMEOUT } from './config'
import { ChatgptAuthError } from './errors'

/** Bounds a response body: OpenAI's JSON replies are a few kilobytes. */
const MAX_BODY = 256 * 1024

export interface HttpResponse {
  status: number
  /** The parsed JSON body, or undefined when it is empty or not JSON. */
  json: unknown
  empty: boolean
}

export type Fetch = typeof fetch

async function readBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array }
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {})
      throw new ChatgptAuthError('server')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One request to OpenAI. Never follows a redirect, gives up after REQUEST_TIMEOUT,
 * and turns every transport failure into a fixed error: fetch's own errors can
 * carry the URL, and a body is never quoted.
 */
export async function send(
  fetchImpl: Fetch,
  url: string,
  init: { method: 'GET' } | { method: 'POST'; form: Record<string, string> },
  signal?: AbortSignal,
): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: init.method,
      redirect: 'error',
      cache: 'no-store',
      signal: combined,
      headers:
        init.method === 'POST'
          ? { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }
          : { accept: 'application/json' },
      ...(init.method === 'POST' ? { body: new URLSearchParams(init.form).toString() } : {}),
    })
  } catch {
    if (signal?.aborted) throw new ChatgptAuthError('cancelled')
    throw new ChatgptAuthError('network')
  }
  let text: string
  try {
    text = await readBody(response)
  } catch (error) {
    if (signal?.aborted) throw new ChatgptAuthError('cancelled')
    throw error instanceof ChatgptAuthError ? error : new ChatgptAuthError('network')
  }
  let json: unknown
  try {
    json = text.trim() ? (JSON.parse(text) as unknown) : undefined
  } catch {
    json = undefined
  }
  return { status: response.status, json, empty: text.length === 0 }
}

/** An OAuth error code from a response body, when it is a plain identifier. */
export function oauthError(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const error = (json as Record<string, unknown>)['error']
  return typeof error === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(error) ? error : undefined
}
