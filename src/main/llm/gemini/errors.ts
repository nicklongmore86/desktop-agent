import type { AgentErrorCode, AgentEvent } from '../../agent/types'

// Gemini errors use the google.rpc.Status shape:
// { error: { code, message, status, details: [{ '@type', reason | retryDelay | violations }] } }.
// Status codes: https://ai.google.dev/gemini-api/docs/troubleshooting and
// https://ai.google.dev/gemini-api/docs/api-errors

const MAX_DETAIL = 160

/** An error with a user-safe message. Raw responses never leave this module. */
export class GeminiError extends Error {
  override readonly name = 'GeminiError'
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly resetsAt?: string,
  ) {
    super(message)
  }
}

/** The agent's error event for any error a Gemini call raised. */
export function geminiErrorEvent(error: unknown): Extract<AgentEvent, { type: 'error' }> {
  if (error instanceof GeminiError)
    return {
      type: 'error',
      code: error.code,
      message: error.message,
      ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}),
    }
  return { type: 'error', code: 'api', message: 'The Gemini request failed. Please try again.' }
}

/**
 * Server text for a message: one line, no secrets, capped. Google echoes request
 * fragments in some messages, so anything shaped like a key is removed as well as the key itself.
 */
export function sanitize(text: unknown, apiKey: string): string {
  if (typeof text !== 'string') return ''
  let clean = text
  if (apiKey) clean = clean.split(apiKey).join('[redacted]')
  clean = clean
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/([?&](?:key|access_token)=)[^&\s]+/gi, '$1[redacted]')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL - 1)}…` : clean
}

interface Status {
  code?: unknown
  message?: unknown
  status?: unknown
  details?: unknown
}

function details(status: Status): Record<string, unknown>[] {
  return Array.isArray(status.details)
    ? status.details.filter(
        (d): d is Record<string, unknown> => typeof d === 'object' && d !== null,
      )
    : []
}

/** Seconds from a protobuf Duration ("38s", "1.5s") or a Retry-After header. */
function delaySeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^\s*(\d+(?:\.\d+)?)s?\s*$/.exec(value)
  const seconds = match ? Number(match[1]) : NaN
  return Number.isFinite(seconds) && seconds >= 0 && seconds < 7 * 86_400 ? seconds : undefined
}

/** Maps an HTTP error response (status and parsed body) to a GeminiError. */
export function httpError(
  httpStatus: number,
  body: unknown,
  apiKey: string,
  retryAfter: string | null = null,
  now: () => number = Date.now,
): GeminiError {
  const status: Status =
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object'
      ? (body.error ?? {})
      : {}
  const items = details(status)
  const reasons = items.map((d) => d.reason).filter((r) => typeof r === 'string')
  const rpc = typeof status.status === 'string' ? status.status : ''
  const code = typeof status.code === 'string' ? status.code : ''
  const raw = typeof status.message === 'string' ? status.message : ''
  const detail = sanitize(raw, apiKey)
  const withDetail = (text: string): string => (detail ? `${text} (${detail})` : text)
  const keyProblem =
    reasons.includes('API_KEY_INVALID') ||
    code === 'authentication' ||
    /api key (?:not valid|invalid|expired)|reported as leaked/i.test(raw)

  if (httpStatus === 401 || ((httpStatus === 400 || httpStatus === 403) && keyProblem))
    return new GeminiError(
      'authentication',
      'Gemini rejected the API key. Check or replace it in settings.',
    )
  if (httpStatus === 400 && /token count|exceeds the maximum number of tokens|too long/i.test(raw))
    return new GeminiError(
      'context_limit',
      'The conversation is too long for this Gemini model. Start a shorter conversation.',
    )
  if (httpStatus === 400 || httpStatus === 413 || httpStatus === 416)
    return new GeminiError('invalid_request', withDetail('Gemini rejected the request.'))
  if (httpStatus === 402)
    return new GeminiError(
      'usage_limit',
      'Gemini API credits are used up. Add credits to the Google AI Studio project.',
    )
  if (httpStatus === 403)
    return new GeminiError(
      'permission',
      withDetail('Gemini denied access. Check the API key restrictions and project settings.'),
    )
  if (httpStatus === 404)
    return new GeminiError(
      'model_unavailable',
      'This Gemini model is not available to the API key. Choose another model.',
    )
  if (httpStatus === 429 || rpc === 'RESOURCE_EXHAUSTED') {
    const retry = items.find((d) => String(d['@type']).endsWith('google.rpc.RetryInfo'))
    const seconds = delaySeconds(retry?.retryDelay) ?? delaySeconds(retryAfter)
    const resetsAt =
      seconds === undefined ? undefined : new Date(now() + seconds * 1000).toISOString()
    const quotaIds = items.flatMap((d) =>
      Array.isArray(d.violations)
        ? d.violations.map((v: unknown) =>
            typeof v === 'object' && v !== null && 'quotaId' in v ? String(v.quotaId) : '',
          )
        : [],
    )
    // Daily (or longer) quotas are a usage limit; per-minute ones are a short rate limit.
    const daily = code === 'quota_exceeded' || quotaIds.some((id) => /PerDay|Daily/i.test(id))
    return daily
      ? new GeminiError(
          'usage_limit',
          'Gemini daily quota for this API key is used up. Try again later or upgrade the key.',
          resetsAt,
        )
      : new GeminiError('rate_limit', 'Gemini rate limit reached. Try again shortly.', resetsAt)
  }
  if (httpStatus === 503 || rpc === 'UNAVAILABLE')
    return new GeminiError('overloaded', 'Gemini is overloaded. Try again later.')
  return new GeminiError('api', 'The Gemini request failed. Please try again.')
}
