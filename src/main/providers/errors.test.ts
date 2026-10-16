import { expect, it, beforeEach, afterEach, vi } from 'vitest'
import { subscriptionFailure } from './errors'

it.each([
  [{ codexErrorInfo: 'usageLimitExceeded' }, 'usage_limit'],
  [{ data: { error: { code: 'usage_limit_reached', resets_at: 1800000000 } } }, 'usage_limit'],
  [{ codexErrorInfo: 'unauthorized' }, 'auth_expired'],
  [{ data: { httpStatusCode: 401 } }, 'auth_expired'],
  [{ message: 'This model is not available on your plan' }, 'plan_not_entitled'],
  [{ code: 'model_not_found' }, 'model_unavailable'],
  [{ errors: ['Your plan does not support Claude Code'] }, 'plan_not_entitled'],
  [{ subtype: 'error_max_turns' }, 'max_turns'],
  [new Error('Runtime could not start.'), 'runtime_unavailable'],
  [{ message: 'unrecognized provider error' }, 'api'],
] as const)('classifies structured runtime failure %#', (input, code) => {
  expect(subscriptionFailure(input, 'codex').code).toBe(code)
})
it('preserves reset time while never forwarding raw secrets, paths or provider prose', () => {
  const error = subscriptionFailure(
    {
      code: 'usage_limit',
      resetsAt: 1800000000,
      message: 'secret sk-private C:\\Users\\private /home/private Bearer token',
      data: { access_token: 'private' },
    },
    'codex',
  )
  expect(error.resetsAt).toBe('2027-01-15T08:00:00.000Z')
  expect(error.message).toContain('resets at')
  expect(JSON.stringify(error)).not.toMatch(/private|Bearer|sk-/)
  expect(error.message).not.toMatch(/private|Bearer|sk-/)
})
it('explains Claude Free entitlement explicitly', () => {
  expect(
    subscriptionFailure({ message: 'Claude Free plan does not include Claude Code' }, 'claude'),
  ).toMatchObject({
    code: 'plan_not_entitled',
    message: "Your Claude plan doesn't include Claude Code. Claude Pro or Max is required.",
  })
})
it('prefers a structured code over ambiguous provider prose', () => {
  expect(
    subscriptionFailure(
      {
        codexErrorInfo: 'usageLimitExceeded',
        message: 'Model unavailable or authentication failed',
      },
      'codex',
    ).code,
  ).toBe('usage_limit')
})

it.each([null, 'badRequest'] as const)(
  'recognizes model denial for ChatGPT accounts through wrapper %s',
  (codexErrorInfo) => {
    expect(
      subscriptionFailure(
        {
          codexErrorInfo,
          message:
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
        'codex',
      ).code,
    ).toBe('plan_not_entitled')
  },
)

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-01-15T00:00:00Z'))
})
afterEach(() => {
  vi.restoreAllMocks()
})

it.each([1800000000 + 9 * 86400, 1800000000 - 2 * 86400, '2099-01-01', Infinity, null])(
  'drops implausible reset %s even inside provider result JSON',
  (resetsAt) => {
    const failure = subscriptionFailure(
      { result: JSON.stringify({ code: 'usage_limit', resetsAt }) },
      'claude',
    )
    expect(failure.code).toBe('usage_limit')
    expect(failure.resetsAt).toBeUndefined()
  },
)
it.each(['request 14001', 'request 14291', 'request 15031', 'request 14001 model details'])(
  'does not interpret arbitrary digits in %s as HTTP status',
  (message) => {
    expect(subscriptionFailure({ message }, 'codex').code).toBe('api')
  },
)
it('includes a date for a reset beyond today', () => {
  const failure = subscriptionFailure(
    { code: 'usage_limit', resetsAt: 1800000000 + 86400 },
    'codex',
  )
  expect(failure.message).toContain('2027')
})
it('uses a neutral message for ambiguous Claude billing errors', () => {
  expect(subscriptionFailure({ code: 'billing_error' }, 'claude')).toMatchObject({ code: 'api' })
})
