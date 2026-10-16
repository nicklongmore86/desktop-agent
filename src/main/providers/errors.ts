import type { AgentErrorCode } from '../agent/types'

export class SubscriptionError extends Error {
  readonly resetsAt?: string
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    resetsAt?: string,
  ) {
    super(message)
    if (resetsAt) this.resetsAt = resetsAt
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Only extract known scalar fields; never forward raw runtime text, paths or credentials. */
export function subscriptionFailure(
  value: unknown,
  provider: 'codex' | 'claude',
): SubscriptionError {
  if (value instanceof SubscriptionError) return value
  const fields: string[] = []
  let resetsAt: string | undefined
  let structuredCode: AgentErrorCode | undefined
  const codes: Record<string, AgentErrorCode> = {
    usageLimitExceeded: 'usage_limit',
    rateLimitExceeded: 'usage_limit',
    sessionBudgetExceeded: 'usage_limit',
    usage_limit: 'usage_limit',
    usage_limit_reached: 'usage_limit',
    rate_limit: 'usage_limit',
    rate_limit_exceeded: 'usage_limit',
    quota_exceeded: 'usage_limit',
    billing_error: 'usage_limit',
    credits_required: 'usage_limit',
    unauthorized: 'auth_expired',
    authentication_failed: 'auth_expired',
    token_expired: 'auth_expired',
    auth_expired: 'auth_expired',
    plan_not_entitled: 'plan_not_entitled',
    model_access_denied: 'plan_not_entitled',
    model_not_found: 'model_unavailable',
    contextWindowExceeded: 'context_limit',
    serverOverloaded: 'overloaded',
    badRequest: 'invalid_request',
    error_max_turns: 'max_turns',
    error_max_budget_usd: 'usage_limit',
  }
  const visit = (input: unknown, depth = 0): void => {
    if (depth > 5) return
    if (typeof input === 'string') {
      fields.push(input.slice(0, 4096))
      if (input.length < 4096 && input.trim().startsWith('{')) {
        try {
          visit(JSON.parse(input), depth + 1)
        } catch {
          /* Plain text remains classification-only. */
        }
      }
      return
    }
    if (Array.isArray(input)) {
      input.slice(0, 10).forEach((item) => {
        visit(item, depth + 1)
      })
      return
    }
    for (const [key, item] of Object.entries(record(input))) {
      if (['code', 'type', 'codexErrorInfo', 'subtype'].includes(key) && typeof item === 'string')
        structuredCode ??= Object.hasOwn(codes, item) ? codes[item] : undefined
      if (key === 'httpStatusCode') {
        const httpCodes: Record<number, AgentErrorCode> = {
          401: 'auth_expired',
          429: 'usage_limit',
          503: 'overloaded',
          400: 'invalid_request',
        }
        if (typeof item === 'number') structuredCode ??= httpCodes[item]
      }
      if (['resetsAt', 'resets_at', 'reset_at'].includes(key)) {
        const time = typeof item === 'number' ? item * 1000 : Date.parse(String(item))
        if (Number.isFinite(time) && time > 0 && time < 8.64e15)
          resetsAt = new Date(time).toISOString()
      } else if (
        [
          'error',
          'errors',
          'data',
          'message',
          'code',
          'type',
          'codexErrorInfo',
          'additionalDetails',
          'httpStatusCode',
          'subtype',
          'result',
          'httpConnectionFailed',
          'responseStreamConnectionFailed',
          'responseStreamDisconnected',
          'responseTooManyFailedAttempts',
        ].includes(key)
      ) {
        if (key.startsWith('http') || key.startsWith('response')) fields.push(key)
        if (typeof item === 'number') fields.push(String(item))
        else visit(item, depth + 1)
      }
    }
  }
  if (value instanceof Error) visit(value.message)
  else visit(value)
  const text = structuredCode ?? fields.join(' ')
  let code: AgentErrorCode = 'api'
  let message =
    'Subscription request failed. Check your connection and provider status in Settings.'
  if (
    /auth_expired|unauthorized|authentication_failed|auth.*expir|sign.in.*expir|401|token.*expir/i.test(
      text,
    )
  ) {
    code = 'auth_expired'
    message = 'Sign-in expired. Sign in again in Settings.'
  } else if (
    /not.entitled|model.*(?:not.*access|access.*not)|not.*(?:included|available).*plan|plan.*(?:not.*support|doesn.t include)|subscription.*required|free.*(?:claude|code)|model.*(?:access|permission).*denied/i.test(
      text,
    )
  ) {
    code = 'plan_not_entitled'
    message =
      provider === 'claude'
        ? "Your Claude plan doesn't include Claude Code. Claude Pro or Max is required."
        : "Your ChatGPT plan doesn't include this model. Choose an available model in Settings."
  } else if (
    /model_unavailable|model.*(?:not.found|unavailable|does.not.exist|not.supported)|model_not_found/i.test(
      text,
    )
  ) {
    code = 'model_unavailable'
    message = 'This model is unavailable. Choose another model in Settings.'
  } else if (
    /usageLimitExceeded|rateLimitExceeded|sessionBudgetExceeded|usage.limit|rate.limit|quota|429|credits_required|billing_error|error_max_budget/i.test(
      text,
    )
  ) {
    code = 'usage_limit'
    message =
      provider === 'codex'
        ? "You've reached your ChatGPT plan's Codex limit."
        : "You've reached your Claude plan's Claude Code limit."
    if (resetsAt)
      message += ` It resets at ${new Date(resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
    else message += ' Check your allowance in Settings or wait for it to reset.'
  } else if (/context_limit|contextWindowExceeded|context.*window.*exceed/i.test(text)) {
    code = 'context_limit'
    message = 'This conversation exceeds the model context window. Start a new chat.'
  } else if (/serverOverloaded|overloaded|503/i.test(text)) {
    code = 'overloaded'
    message = 'The provider is overloaded. Try again later.'
  } else if (
    /httpConnectionFailed|responseStreamConnectionFailed|responseStreamDisconnected|network|ECONN|ENOTFOUND/i.test(
      text,
    )
  ) {
    code = 'network'
    message = 'The provider connection failed. Check your connection and try again.'
  } else if (/badRequest|invalid_request|400/i.test(text)) {
    code = 'invalid_request'
    message = 'The provider rejected this request. Check the selected model in Settings.'
  } else if (/max_turns|error_max_turns/i.test(text)) {
    code = 'max_turns'
    message = 'Claude reached the turn limit for this request.'
  } else if (
    /Invalid (?:runtime|thread|turn)|ended without a completed|Missing runtime|Runtime.*(?:start|exit|closed|timed out|failed|protocol)|Unsupported.*(?:configuration|requirements|skills|runtime)|isolation configuration/i.test(
      text,
    )
  ) {
    code = 'runtime_unavailable'
    message =
      'The bundled subscription runtime is unavailable or its configuration is unsupported. Check Settings.'
  } else if (
    /sign.in|not.signed.in|API.*(?:accepted|authentication)|subscription.*sign.in/i.test(text)
  ) {
    code = 'authentication'
    message = 'Sign in with your subscription in Settings. API credentials are not accepted.'
  }
  return new SubscriptionError(code, message, code === 'usage_limit' ? resetsAt : undefined)
}
