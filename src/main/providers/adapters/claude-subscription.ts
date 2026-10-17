import type { ProviderAllowance, ProviderFailure } from '../../../shared/ipc'
import { CLAUDE_SUBSCRIPTION } from '../../../shared/ipc-connections'
import type { AgentErrorCode } from '../../agent'
import { createClaudeSubscriptionRunner } from '../claude'
import { ClaudeLogin } from '../claude-login'
import type { AdapterFactory, ConnectionAdapter } from '../connection'
import { CLAUDE_FAILURES, mapFailure, plausibleReset, SubscriptionError } from '../errors'
import { object } from '../rpc'
import { capture } from '../runtime'
import { failedStatus, failureCopy, limitedStatus, signedInStatus } from './status'

const NOT_ENTITLED = "Your Claude plan doesn't include Claude Code. Claude Pro or Max is required."

/**
 * Claude by subscription, through the bundled Claude Code runtime signed in with a
 * Claude.ai account. The runtime is locked down in claude.ts (no tools of its own,
 * no setting sources, API-key and Free accounts refused, init tools checked).
 * Personal use only: see docs/connections.md.
 */
export const createClaudeSubscriptionAdapter: AdapterFactory = (host) => {
  const id = CLAUDE_SUBSCRIPTION
  /** The plan Claude reported, kept to tell Free from Pro/Max between checks. */
  let plan: string | undefined
  /** A structured, rejected rate limit's reset: the only signal that blocks Send. */
  let limit: string | undefined
  /** The last run failure: shown in Usage, never used to block Send. */
  let lastFailure: ProviderFailure | undefined

  const failure = (error: unknown): SubscriptionError => mapFailure(error, CLAUDE_FAILURES)
  const trustedLimit = (): string | undefined =>
    limit && plausibleReset(limit) && Date.parse(limit) > Date.now() ? limit : undefined

  const adapter: ConnectionAdapter = {
    id,
    vendor: 'anthropic',
    access: 'subscription',
    label: 'Claude · Subscription',
    shortLabel: 'Claude',
    title: 'Claude · Subscription',
    description: 'Sign in with your Claude account. No API key needed.',
    runtimeLabel: 'Claude Code',
    capabilities: {
      authKind: 'runtime-login',
      listsModels: false,
      reportsUsage: false,
      needsRuntime: true,
    },
    personalUseOnly: true,
    pickerOrder: 1,
    failure,

    allowance(): Promise<ProviderAllowance> {
      const reset = lastFailure?.resetsAt ? Date.parse(lastFailure.resetsAt) : null
      const limited = lastFailure?.code === 'usage_limit' && (!reset || reset > Date.now())
      return Promise.resolve({
        provider: id,
        plan: plan ?? null,
        windows: [],
        resetsAt: limited ? (lastFailure?.resetsAt ?? null) : null,
        state: limited ? 'limited' : 'unknown',
        lastError: failureCopy(lastFailure),
      })
    },

    async status(signal) {
      const check = host.track(signal)
      let signedIn: boolean | undefined
      try {
        const context = await host.context('claude', check.signal)
        let ready = false
        let current: string | undefined
        try {
          const auth = object(
            JSON.parse(
              await capture(
                context.file,
                ['auth', 'status'],
                context.cwd,
                context.env,
                check.signal,
                10000,
                // Claude auth status uses exit 1 for a valid signed-out JSON response.
                [0, 1],
              ),
            ),
          )
          ready = auth['loggedIn'] === true && auth['authMethod'] === 'claude.ai'
          if (
            typeof auth['subscriptionType'] === 'string' &&
            /^[\w -]{1,60}$/.test(auth['subscriptionType'])
          ) {
            current = auth['subscriptionType']
            plan = current
          }
        } catch (error) {
          throw failure(error)
        }
        signedIn = ready
        let allowance: ProviderAllowance | undefined
        if (ready) {
          current ??= plan
          allowance = await adapter.allowance?.()
        }
        if (ready && current && /^(?:claude\s*)?free$/i.test(current))
          return {
            provider: id,
            signedIn: true,
            availability: 'blocked',
            state: 'not-entitled',
            message: NOT_ENTITLED,
            failure: { code: 'plan_not_entitled', message: NOT_ENTITLED },
          }
        const reset = trustedLimit()
        if (ready && reset)
          return limitedStatus(id, failure({ code: 'usage_limit', resetsAt: reset }), reset)
        return signedInStatus(id, ready, allowance)
      } catch (error) {
        return failedStatus(id, error, signedIn, failure)
      } finally {
        check.done()
      }
    },

    async login(session) {
      const context = await host.context('claude', session.signal)
      session.signal.throwIfAborted()
      const login = new ClaudeLogin(context, {
        signal: session.signal,
        openUrl: host.openUrl,
        onUrl: session.urlReady,
        ...(host.loginTimeout ? { timeout: host.loginTimeout } : {}),
      })
      session.attach(login)
      await login.done
      lastFailure = undefined
      limit = undefined
      plan = undefined
    },

    async runner(tools, signal) {
      const status = await adapter.status(signal)
      const reset = trustedLimit()
      const trusted = reset !== undefined
      // Remembered free-text errors are display-only. Only structured plan/limit signals gate Send.
      if (!['ready', 'limited'].includes(status.state) || trusted)
        throw new SubscriptionError(
          trusted
            ? 'usage_limit'
            : ((status.failure?.code as AgentErrorCode | undefined) ??
                (status.state === 'signed-out' ? 'authentication' : 'runtime_unavailable')),
          status.message,
          trusted ? reset : undefined,
        )
      const context = await host.context('claude', signal)
      return createClaudeSubscriptionRunner(context, tools, {
        onAccount: (next) => {
          if (/^[\w -]{1,60}$/.test(next)) plan = next
        },
        onLimit: (next) => {
          limit = next && plausibleReset(next) ? next : undefined
        },
        onAvailable: () => {
          lastFailure = undefined
          limit = undefined
        },
        onFailure: (next) => {
          lastFailure = next
        },
      })
    },
  }
  return adapter
}
