import type { ConnectionId } from '../../../shared/ipc-connections'
import type { ProviderAllowance, ProviderFailure, ProviderStatus } from '../../../shared/ipc'
import type { SubscriptionError } from '../errors'

/** The status-building steps the subscription adapters share. */

/** Signed in (or not) and not blocked by a plan limit. */
export function signedInStatus(
  provider: ConnectionId,
  ready: boolean,
  allowance: ProviderAllowance | undefined,
): ProviderStatus {
  return {
    provider,
    signedIn: ready,
    availability: ready && allowance?.state === 'available' ? 'available' : 'unknown',
    state: ready ? 'ready' : 'signed-out',
    message: ready
      ? 'Subscription signed in. No API key is used.'
      : 'Sign in with your subscription. API accounts and copied tokens are not accepted.',
  }
}

/** Signed in, but the plan's limit is reached. */
export function limitedStatus(
  provider: ConnectionId,
  failure: SubscriptionError,
  resetsAt: string | undefined,
): ProviderStatus {
  return {
    provider,
    signedIn: true,
    availability: 'blocked',
    state: 'limited',
    message: failure.message,
    failure: {
      code: failure.code,
      message: failure.message,
      ...(resetsAt ? { resetsAt } : {}),
    },
  }
}

/** The check itself failed; only the mapped message is shown, never the error's own text. */
export function failedStatus(
  provider: ConnectionId,
  error: unknown,
  signedIn: boolean | undefined,
  map: (error: unknown) => SubscriptionError,
): ProviderStatus {
  const failure = map(error)
  const message = error instanceof Error ? error.message : 'Runtime check failed.'
  return {
    provider,
    state: message.startsWith('Missing runtime')
      ? 'missing-runtime'
      : message.startsWith('Unsupported')
        ? 'unsupported'
        : 'error',
    message: failure.message,
    ...(signedIn !== undefined
      ? { signedIn: failure.code === 'auth_expired' ? false : signedIn }
      : {}),
    availability:
      failure.code === 'plan_not_entitled' || failure.code === 'usage_limit'
        ? 'blocked'
        : 'unknown',
    failure: {
      code: failure.code,
      message: failure.message,
      ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
    },
  }
}

/** A serializable copy of the last run failure, for the allowance report. */
export function failureCopy(failure: ProviderFailure | undefined): ProviderFailure | null {
  return failure
    ? {
        code: failure.code,
        message: failure.message,
        ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
      }
    : null
}
