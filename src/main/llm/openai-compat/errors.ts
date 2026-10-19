import type { AgentErrorCode, AgentEvent } from '../../agent/types'
import { plausibleReset } from '../../providers/errors'

/** Longest error message; longer text is cut. */
export const MAX_MESSAGE = 300

/**
 * The only error this client throws. Messages are fixed, app-written text (capped), never
 * provider response text: OpenAI echoes the submitted key in its 401 message, for one.
 */
export class OpenAICompatError extends Error {
  readonly resetsAt?: string
  readonly status?: number
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    options: { status?: number; resetsAt?: string } = {},
  ) {
    super(message.slice(0, MAX_MESSAGE))
    this.name = 'OpenAICompatError'
    if (options.status !== undefined) this.status = options.status
    const reset = plausibleReset(options.resetsAt)
    if (reset) this.resetsAt = reset
  }
}

export function openAICompatErrorEvent(error: unknown): Extract<AgentEvent, { type: 'error' }> {
  const failure =
    error instanceof OpenAICompatError
      ? error
      : new OpenAICompatError('api', 'The model request failed. Please try again.')
  return {
    type: 'error',
    code: failure.code,
    message: failure.message,
    ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** The provider's error object: OpenAI `{error:{type,code,message}}`, OpenRouter `{error:{code:429}}`, Ollama `{error:"..."}`. */
export function providerError(body: unknown): { kind: string; text: string; code?: number } {
  const outer = record(body)
  const inner = typeof outer.error === 'string' ? { message: outer.error } : record(outer.error)
  const kind = [inner.code, inner.type].filter((v) => typeof v === 'string').join(' ')
  const text = typeof inner.message === 'string' ? inner.message.slice(0, 2000) : ''
  return { kind, text, ...(typeof inner.code === 'number' ? { code: inner.code } : {}) }
}

/** Matched internally only; the text itself is never surfaced. */
const CONTEXT_LIMIT =
  /context_length_exceeded|context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|exceeds? the (model'?s? )?(context|maximum)/i
const MODEL_MISSING = /model_not_found|model[ _-]?not[ _-]?found|no such model|does not exist/i

/** `retry-after-ms`, `retry-after` (seconds or HTTP date), then OpenAI's `x-ratelimit-reset-*` ("6m0s"). */
export function retryAt(headers: Headers, now = Date.now()): string | undefined {
  const ms = Number(headers.get('retry-after-ms'))
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0)
    return new Date(now + ms).toISOString()
  const after = headers.get('retry-after')?.trim()
  if (after) {
    if (/^\d+(\.\d+)?$/.test(after)) return new Date(now + Number(after) * 1000).toISOString()
    const date = Date.parse(after)
    if (Number.isFinite(date)) return new Date(date).toISOString()
  }
  const resets = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']
    .map((name) => duration(headers.get(name)))
    .filter((v): v is number => v !== undefined)
  return resets.length ? new Date(now + Math.max(...resets)).toISOString() : undefined
}

function duration(value: string | null): number | undefined {
  const match = value
    ?.trim()
    .match(/^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/)
  if (!match || match[0] === '') return undefined
  const [, h = '0', m = '0', s = '0', ms = '0'] = match
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms)
}

/** Maps a non-2xx response (or an in-stream error object, `status` from its numeric code). */
export function statusError(
  status: number,
  body: unknown,
  label: string,
  headers?: Headers,
): OpenAICompatError {
  const { kind, text } = providerError(body)
  const opts = { status }
  if (CONTEXT_LIMIT.test(kind) || ((status === 400 || status === 413) && CONTEXT_LIMIT.test(text)))
    return new OpenAICompatError(
      'context_limit',
      'Conversation exceeds the model context window. Start a shorter conversation.',
      opts,
    )
  if (status === 401)
    return new OpenAICompatError(
      'authentication',
      `${label} rejected the API key. Update it in settings.`,
      opts,
    )
  if (status === 402)
    return new OpenAICompatError(
      'usage_limit',
      `${label} reports insufficient credits for this request.`,
      opts,
    )
  if (status === 403)
    return new OpenAICompatError(
      'permission',
      `${label} denied access. Check the API key permissions and model access.`,
      opts,
    )
  if (status === 404 || MODEL_MISSING.test(kind) || (status === 400 && MODEL_MISSING.test(text)))
    return new OpenAICompatError(
      'model_unavailable',
      `${label} could not find this model. Choose another model.`,
      opts,
    )
  if (status === 408)
    return new OpenAICompatError('network', `The ${label} request timed out. Try again.`, opts)
  if (status === 429) {
    const resetsAt = headers ? retryAt(headers) : undefined
    if (/insufficient_quota/.test(kind))
      return new OpenAICompatError(
        'usage_limit',
        `${label} quota exhausted. Check your plan and billing.`,
        { ...opts, ...(resetsAt ? { resetsAt } : {}) },
      )
    return new OpenAICompatError('rate_limit', `${label} rate limit reached. Try again later.`, {
      ...opts,
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  if (status === 400 || status === 413 || status === 422)
    return new OpenAICompatError(
      'invalid_request',
      `${label} rejected the request. Check the model, message format and request size.`,
      opts,
    )
  if (status === 503 || status === 529)
    return new OpenAICompatError('overloaded', `${label} is overloaded. Try again later.`, opts)
  return new OpenAICompatError('api', `The ${label} request failed. Please try again.`, opts)
}
