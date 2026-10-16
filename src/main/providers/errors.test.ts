import { expect, it } from 'vitest'
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
