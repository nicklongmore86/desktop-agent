import type { AgentErrorCode } from '../../agent/types'
import { OpenAICompatError, retryAt } from '../openai-compat/errors'

export const LABEL = 'ChatGPT'
/** Where ChatGPT plan users review and change their usage limits. */
export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage'

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

/** `error.param` names a request field ("tools[0].type"); anything else is dropped. */
const PARAM = /^[A-Za-z0-9_.[\]]{1,64}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/
/** A field of the tool definitions, or a replayed call's namespace: the parts most likely to change. */
const TOOL_PARAM = /^(tools($|[[.])|input\[\d+\]\.(namespace|name)$)/

/**
 * The tool grouping (one `namespace` of non-strict functions) is the least settled part of
 * ChatGPT plan use, so a rejection of it gets its own message naming the field. The field
 * path passed PARAM, so it is never provider text.
 */
export const toolFormatMessage = (param: string): string =>
  `ChatGPT plan use did not accept this app’s tool format (${param}), so nothing was run. Please report this problem.`

/** True for a rejection of the request's tool definitions (see toolFormatMessage). */
export function isToolFormatError(error: unknown): error is ResponsesError & { param: string } {
  return error instanceof ResponsesError && error.toolFormat
}

function requestIdOf(headers?: Headers): string | undefined {
  return short(headers?.get('x-request-id') ?? headers?.get('openai-request-id'), REQUEST_ID)
}

/**
 * Maps a Responses error object (`{code, message, param}`) and/or HTTP status. `status`
 * is undefined for in-stream failures (response.failed, error events).
 */
export function responsesError(
  error: unknown,
  status: number | undefined,
  headers?: Headers,
): ResponsesError {
  const e = record(error)
  const providerCode = typeof e.code === 'string' ? e.code : ''
  const requestId = requestIdOf(headers)
  const base = {
    ...(status !== undefined ? { status } : {}),
    ...(requestId ? { requestId } : {}),
  }
  const param = short(e.param, PARAM)
  // A rejected tool definition: an unsupported capability or an invalid request naming one.
  const rejected =
    providerCode === 'subscription_sharing_unsupported_capability' ||
    (!Object.hasOwn(KNOWN, providerCode) &&
      (status === undefined || status === 400 || status === 422))
  if (param && rejected && TOOL_PARAM.test(param))
    return new ResponsesError('invalid_request', toolFormatMessage(param), {
      ...base,
      ...(Object.hasOwn(KNOWN, providerCode) ? { providerCode } : {}),
      param,
      retryable: false,
      toolFormat: true,
    })
  const known = KNOWN[providerCode]
  if (known) {
    return new ResponsesError(known.code, known.message, {
      ...base,
      providerCode,
      retryable: known.retryable,
      ...(param && providerCode === 'subscription_sharing_unsupported_capability' ? { param } : {}),
    })
  }
  const kind = [e.code, e.type].filter((v) => typeof v === 'string').join(' ')
  if (CONTEXT_LIMIT.test(kind))
    return new ResponsesError(
      'context_limit',
      'Conversation exceeds the model context window. Start a shorter conversation.',
      { ...base, retryable: false },
    )
  if (MODEL_MISSING.test(kind) || status === 404)
    return new ResponsesError(
      'model_unavailable',
      'This model is not available on your ChatGPT plan. Choose another model.',
      { ...base, retryable: false },
    )
  // Direct-route admission failures answer `{"detail": "..."}` with no stable code.
  switch (status) {
    case 401:
      return new ResponsesError(
        'auth_expired',
        `ChatGPT did not accept the sign-in. ${SIGN_IN_AGAIN}`,
        {
          ...base,
          retryable: false,
        },
      )
    case 403:
      return new ResponsesError(
        'permission',
        'ChatGPT denied this request, for example because of your region or workspace policy.',
        { ...base, retryable: false },
      )
    case 408:
      return new ResponsesError('network', 'The ChatGPT request timed out. Try again.', base)
    case 429: {
      const resetsAt = headers ? retryAt(headers) : undefined
      return new ResponsesError('rate_limit', 'ChatGPT rate limit reached. Try again later.', {
        ...base,
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
    case 400:
    case 413:
    case 422:
      return new ResponsesError(
        'invalid_request',
        'ChatGPT rejected the request. Check the model and the request size.',
        { ...base, retryable: false },
      )
    case 503:
      return new ResponsesError(
        'overloaded',
        'ChatGPT plan use is unavailable right now. Try again later.',
        base,
      )
  }
  return new ResponsesError('api', 'The ChatGPT request failed. Please try again.', base)
}

/** The `statusError` hook for connect(): body is `{error:{...}}`, `{detail}` or text. */
export function responsesStatusError(
  status: number,
  body: unknown,
  _label: string,
  headers?: Headers,
): ResponsesError {
  return responsesError(record(body).error, status, headers)
}
