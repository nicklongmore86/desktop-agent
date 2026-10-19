import type { AgentErrorCode } from '../../agent/types'
import { MANAGE_USAGE_URL } from '../../../shared/chatgpt-plan'
import { MAX_MESSAGE, OpenAICompatError, retryAt } from '../openai-compat/errors'
import type { SecretCheck } from '../openai-compat/http'
import { mediaType } from '../openai-compat/stream'

export const LABEL = 'ChatGPT'
/** Where ChatGPT plan users review and change their usage limits. */
export { MANAGE_USAGE_URL }

/**
 * An OpenAICompatError with the ChatGPT-plan details the docs say to preserve. Messages
 * stay app-written: the provider's text, `detail` and token never reach them.
 */
export class ResponsesError extends OpenAICompatError {
  /** The documented error code, when the provider sent one this client knows. */
  readonly providerCode?: string
  /** `error.param` for an unsupported capability, when it is a plain field path. */
  readonly param?: string
  readonly requestId?: string
  /** False when sending the same body again cannot succeed. */
  readonly retryable: boolean
  /** The request's tool definitions were rejected; `param` names the field. */
  readonly toolFormat: boolean
  /** The message's diagnostics() suffix, so a caller that rewords the message can keep it. */
  readonly details: string
  constructor(
    code: AgentErrorCode,
    message: string,
    options: {
      status?: number
      resetsAt?: string
      providerCode?: string
      param?: string
      requestId?: string
      retryable?: boolean
      toolFormat?: boolean
      details?: string
    } = {},
  ) {
    super(code, message, {
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.resetsAt ? { resetsAt: options.resetsAt } : {}),
    })
    this.name = 'ResponsesError'
    if (options.providerCode) this.providerCode = options.providerCode
    if (options.param) this.param = options.param
    if (options.requestId) this.requestId = options.requestId
    this.retryable = options.retryable ?? true
    this.toolFormat = options.toolFormat ?? false
    this.details = options.details ?? ''
  }
}

const SIGN_IN_AGAIN = 'Sign in with ChatGPT again.'

/**
 * Documented codes (errors-and-recovery.md, "Structured Responses errors") with the
 * status each is documented under. In-stream failures carry no HTTP status.
 */
const KNOWN: Record<
  string,
  { status: number; code: AgentErrorCode; message: string; retryable: boolean }
> = {
  subscription_sharing_usage_limit_exceeded: {
    status: 429,
    code: 'usage_limit',
    // No reset time: the docs say not to infer one, and an app-specific limit may apply.
    message: `ChatGPT usage limit reached for your plan or this app. Choose Manage usage to review it at ${MANAGE_USAGE_URL}.`,
    retryable: false,
  },
  subscription_sharing_user_not_eligible: {
    status: 403,
    code: 'plan_not_entitled',
    message:
      'Needs ChatGPT Plus or Pro. ChatGPT plan use is not available for this account or workspace. Use an OpenAI API key instead.',
    retryable: false,
  },
  subscription_sharing_usage_unavailable: {
    status: 503,
    code: 'overloaded',
    message: 'ChatGPT could not check your plan usage right now. Try again in a few minutes.',
    retryable: true,
  },
  subscription_sharing_user_unavailable: {
    status: 503,
    code: 'overloaded',
    message: 'ChatGPT account details are temporarily unavailable. Try again in a few minutes.',
    retryable: true,
  },
  subscription_sharing_unsupported_capability: {
    status: 400,
    code: 'invalid_request',
    message:
      'ChatGPT plan use does not support part of this request, such as the model, a tool or an attachment.',
    retryable: false,
  },
  subscription_sharing_route_not_supported: {
    status: 403,
    code: 'api',
    message: 'ChatGPT plan use does not support this request type. Please report this problem.',
    retryable: false,
  },
  subscription_sharing_invalid_user: {
    status: 401,
    code: 'auth_expired',
    message: `ChatGPT could not confirm your account. ${SIGN_IN_AGAIN}`,
    retryable: false,
  },
  chatpass_v2_scope_not_authorized: {
    status: 403,
    code: 'auth_expired',
    message: `This sign-in does not allow ChatGPT plan use. ${SIGN_IN_AGAIN} and allow plan use.`,
    retryable: false,
  },
  chatpass_v2_invalid_authorization_context: {
    status: 403,
    code: 'auth_expired',
    message: `This sign-in does not allow ChatGPT plan use. ${SIGN_IN_AGAIN} and allow plan use.`,
    retryable: false,
  },
}

/** Matched internally only; the text itself is never surfaced. */
const CONTEXT_LIMIT = /context_length_exceeded|context_window_exceeded/
const MODEL_MISSING = /model_not_found/

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const short = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined

/**
 * `error.param` names a request field ("tools[0].type", "input[4].namespace"): lowercase
 * field names joined by `.` or indexed by `[n]`. Anything else (a token included) is dropped.
 */
const PARAM = /^(?=.{1,64}$)[a-z][a-z_]{0,31}(\[\d{1,4}\]|\.[a-z][a-z_]{0,31}){0,8}$/
/** OpenAI's request ids: `req_` and a short alphanumeric id. */
const REQUEST_ID = /^req_[A-Za-z0-9]{1,64}$/
/** A field of the tool definitions, or a replayed call's namespace: the parts most likely to change. */
const TOOL_PARAM = /^(tools($|[[.])|input\[\d+\]\.(namespace|name)$)/

/**
 * The tool grouping (one `namespace` of non-strict functions) is the least settled part of
 * ChatGPT plan use, so a rejection of it gets its own message naming the field. The field
 * path passed PARAM and the secret check, so it is never provider text or the token.
 */
export const toolFormatMessage = (param: string): string =>
  `ChatGPT plan use did not accept this app’s tool format (${param}), so nothing was run. Please report this problem.`

/** True for a rejection of the request's tool definitions (see toolFormatMessage). */
export function isToolFormatError(error: unknown): error is ResponsesError & { param: string } {
  return error instanceof ResponsesError && error.toolFormat
}

/**
 * `error.code`: snake_case words ("invalid_value", "chatpass_v2_scope_not_authorized").
 * Codes are not allowlisted, because an unknown code is exactly what a report needs; the
 * shape (no upper case, no digits in the first word) and the secret check keep a token out.
 */
const CODE = /^(?=.{1,64}$)[a-z]{2,}(_[a-z0-9]+){0,7}$/
/** `error.type`: OpenAI's small, stable set. Anything else is not shown. */
const ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'insufficient_quota',
  'server_error',
  'api_error',
  'requests',
  'tokens',
])
/** A Responses object's `status`. */
const RESPONSE_STATUS = /^[a-z_]{1,32}$/
/** Media types shown by name; any other value could be anything, so it is not shown. */
const MEDIA_TYPES = new Set([
  'application/json',
  'application/problem+json',
  'application/x-ndjson',
  'application/octet-stream',
  'text/event-stream',
  'text/html',
  'text/plain',
])

/** A failed response's facts, each checked against a strict pattern before it is shown. */
export interface Diagnostics {
  /** The HTTP status, including a 2xx whose body was not a stream. */
  status?: number
  /** The response headers: their Content-Type and request id are shown. */
  headers?: Headers
  code?: unknown
  type?: unknown
  param?: unknown
  /** What the body was, e.g. "body detail": app-written only. */
  body?: string
  /** A Responses object's `status`, shown after the body kind. */
  responseStatus?: unknown
  /** Drops any value that echoes the credential sent with the request. */
  isSecret?: SecretCheck
  /** Longest result; the least useful parts are left out to fit. */
  max?: number
}

/**
 * " Details: HTTP 400, application/json, code invalid_value, param model, request req_1."
 * so a report says what OpenAI answered. Each provider value must match its pattern and
 * share no run with the credential (see sharesSecret); provider text and other header
 * values never appear. Empty when there is nothing to show.
 */
export function diagnostics(facts: Diagnostics): string {
  const { isSecret = () => false } = facts
  const safe = (value: unknown, ok: (v: string) => boolean): string | undefined =>
    typeof value === 'string' && ok(value) && !isSecret(value) ? value : undefined
  // [priority, text]: the lowest priority is left out first when the result must be shorter.
  const parts: [number, string][] = []
  if (facts.status !== undefined) parts.push([7, `HTTP ${String(facts.status)}`])
  if (facts.headers) {
    const type = mediaType(facts.headers.get('content-type'))
    parts.push([
      2,
      type === undefined ? 'no content type' : MEDIA_TYPES.has(type) ? type : 'other content type',
    ])
  }
  if (facts.body) {
    const status = safe(facts.responseStatus, (v) => RESPONSE_STATUS.test(v))
    parts.push([3, status ? `${facts.body} ${status}` : facts.body])
  }
  const code = safe(facts.code, (v) => CODE.test(v))
  if (code) parts.push([5, `code ${code}`])
  const type = safe(facts.type, (v) => ERROR_TYPES.has(v))
  if (type) parts.push([1, `type ${type}`])
  const param = safe(facts.param, (v) => PARAM.test(v))
  if (param) parts.push([4, `param ${param}`])
  const requestId = requestIdOf(facts.headers, isSecret)
  if (requestId) parts.push([6, `request ${requestId}`])
  const render = (): string =>
    parts.length ? ` Details: ${parts.map(([, text]) => text).join(', ')}.` : ''
  const max = facts.max ?? Infinity
  while (parts.length && render().length > max) {
    const lowest = Math.min(...parts.map(([priority]) => priority))
    parts.splice(
      parts.findIndex(([priority]) => priority === lowest),
      1,
    )
  }
  return render()
}

function requestIdOf(headers: Headers | undefined, isSecret: SecretCheck): string | undefined {
  const id = short(headers?.get('x-request-id') ?? headers?.get('openai-request-id'), REQUEST_ID)
  return id && !isSecret(id) ? id : undefined
}

/**
 * Maps a Responses error object (`{code, message, param}`) and/or HTTP status. `status`
 * is undefined for in-stream failures (response.failed, error events) and for an error
 * body sent with a 2xx; `context.httpStatus` is then the 2xx, shown in the details.
 * Every message ends with diagnostics(); `context.isSecret` keeps the credential out.
 */
export function responsesError(
  error: unknown,
  status: number | undefined,
  headers?: Headers,
  context: {
    httpStatus?: number
    body?: string
    responseStatus?: unknown
    isSecret?: SecretCheck
  } = {},
): ResponsesError {
  const { isSecret = () => false } = context
  const httpStatus = context.httpStatus ?? status
  const e = record(error)
  const providerCode = typeof e.code === 'string' ? e.code : ''
  const requestId = requestIdOf(headers, isSecret)
  const param =
    typeof e.param === 'string' && !isSecret(e.param) ? short(e.param, PARAM) : undefined
  const facts: Diagnostics = {
    ...(httpStatus !== undefined ? { status: httpStatus } : {}),
    ...(headers ? { headers } : {}),
    ...(context.body ? { body: context.body, responseStatus: context.responseStatus } : {}),
    code: e.code,
    type: e.type,
    param,
    isSecret,
  }
  const base = {
    ...(status !== undefined ? { status } : {}),
    ...(requestId ? { requestId } : {}),
  }
  /** `message` plus as much of the diagnostics as fits in MAX_MESSAGE. */
  const make = (
    code: AgentErrorCode,
    message: string,
    options: ConstructorParameters<typeof ResponsesError>[2] = {},
  ): ResponsesError => {
    const details = diagnostics({ ...facts, max: MAX_MESSAGE - message.length })
    return new ResponsesError(code, `${message}${details}`, { ...base, ...options, details })
  }
  // A rejected tool definition: an unsupported capability or an invalid request naming one.
  const rejected =
    providerCode === 'subscription_sharing_unsupported_capability' ||
    (!Object.hasOwn(KNOWN, providerCode) &&
      (status === undefined || status === 400 || status === 422))
  if (param && rejected && TOOL_PARAM.test(param))
    return make('invalid_request', toolFormatMessage(param), {
      ...(Object.hasOwn(KNOWN, providerCode) ? { providerCode } : {}),
      param,
      retryable: false,
      toolFormat: true,
    })
  const known = KNOWN[providerCode]
  if (known) {
    return make(known.code, known.message, {
      providerCode,
      retryable: known.retryable,
      ...(param && providerCode === 'subscription_sharing_unsupported_capability' ? { param } : {}),
    })
  }
  const kind = [e.code, e.type].filter((v) => typeof v === 'string').join(' ')
  const fail = (code: AgentErrorCode, message: string, retryable: boolean, resetsAt?: string) =>
    make(code, message, { retryable, ...(resetsAt ? { resetsAt } : {}) })
  if (CONTEXT_LIMIT.test(kind))
    return fail(
      'context_limit',
      'Conversation exceeds the model context window. Start a shorter conversation.',
      false,
    )
  if (MODEL_MISSING.test(kind) || status === 404)
    return fail(
      'model_unavailable',
      'This model is not available on your ChatGPT plan. Choose another model.',
      false,
    )
  // Direct-route admission failures answer `{"detail": "..."}` with no stable code.
  switch (status) {
    case 401:
      return fail('auth_expired', `ChatGPT did not accept the sign-in. ${SIGN_IN_AGAIN}`, false)
    case 403:
      return fail(
        'permission',
        'ChatGPT denied this request, for example because of your region or workspace policy.',
        false,
      )
    case 408:
      return fail('network', 'The ChatGPT request timed out. Try again.', true)
    case 429:
      return fail(
        'rate_limit',
        'ChatGPT rate limit reached. Try again later.',
        true,
        headers ? retryAt(headers) : undefined,
      )
    case 400:
    case 413:
    case 422:
      return fail(
        'invalid_request',
        'ChatGPT rejected the request. Check the model and the request size.',
        false,
      )
    case 503:
      return fail('overloaded', 'ChatGPT plan use is unavailable right now. Try again later.', true)
  }
  return fail('api', 'The ChatGPT request failed. Please try again.', true)
}

/** The `statusError` hook for connect(): body is `{error:{...}}`, `{detail}` or text. */
export function responsesStatusError(
  status: number,
  body: unknown,
  _label: string,
  headers?: Headers,
  isSecret?: SecretCheck,
): ResponsesError {
  const outer = record(body)
  return responsesError(outer.error, status, headers, {
    body: typeof outer.detail === 'string' ? 'body detail' : '',
    ...(isSecret ? { isSecret } : {}),
  })
}
