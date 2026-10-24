import type { ProviderAllowance, ProviderFailure, ProviderModels } from '../../../shared/ipc'
import { CODEX_SUBSCRIPTION } from '../../../shared/ipc-connections'
import { codexAllowance, codexModels } from '../catalog'
import { codexAccount, codexLogin, connectCodex, createCodexRunner } from '../codex'
import type { AdapterFactory, ConnectionAdapter } from '../connection'
import { CODEX_FAILURES, mapFailure, SubscriptionError } from '../errors'
import type { RpcPeer } from '../rpc'
import { failedStatus, failureCopy, limitedStatus, signedInStatus } from './status'

/**
 * Codex by ChatGPT subscription, through the bundled Codex runtime. The runtime is
 * locked down in codex.ts (ChatGPT login forced, config layers and API keys refused).
 * Auth, entitlement and usage errors are checked inside the single run process.
 */
export const createCodexSubscriptionAdapter: AdapterFactory = (host) => {
  const id = CODEX_SUBSCRIPTION
  let catalogCache: { value: ProviderModels; expiresAt: number } | undefined
  let catalogGeneration = 0
  /** The model the last run actually used, which can differ from the saved one. */
  let resolved: string | undefined
  let lastFailure: ProviderFailure | undefined

  const failure = (error: unknown): SubscriptionError => mapFailure(error, CODEX_FAILURES)

  const cachedCatalog = (): ProviderModels | undefined => {
    if (!catalogCache || catalogCache.expiresAt <= Date.now()) return undefined
    return { ...catalogCache.value, resolvedModel: resolved ?? null }
  }

  const readCatalog = async (peer: RpcPeer): Promise<ProviderModels> => {
    const cached = cachedCatalog()
    if (cached) return cached
    const generation = catalogGeneration
    const value = await codexModels(peer, host.settings?.selection(id) ?? null)
    if (generation === catalogGeneration) catalogCache = { value, expiresAt: Date.now() + 60000 }
    return { ...value, resolvedModel: resolved ?? null }
  }

  /** Metadata failures use the same safe error contract as chat failures. */
  const metadata = async <T>(read: (peer: RpcPeer) => Promise<T>): Promise<T> => {
    let peer: RpcPeer | undefined
    try {
      peer = await connectCodex(await host.context('codex'))
      if (!(await codexAccount(peer)))
        throw new SubscriptionError('authentication', 'Sign in with ChatGPT in Settings.')
      return await read(peer)
    } catch (error) {
      throw failure(error)
    } finally {
      peer?.close()
    }
  }

  const models = (): Promise<ProviderModels> => {
    const cached = cachedCatalog()
    return cached ? Promise.resolve(cached) : metadata(readCatalog)
  }
  const invalidate = (): void => {
    catalogGeneration++
    catalogCache = undefined
  }

  const adapter: ConnectionAdapter = {
    id,
    vendor: 'openai',
    access: 'subscription',
    label: 'Codex · ChatGPT',
    shortLabel: 'Codex',
    title: 'Codex · ChatGPT',
    description: 'Sign in with your ChatGPT account. No API key needed.',
    runtimeLabel: 'Codex',
    capabilities: {
      authKind: 'runtime-login',
      listsModels: true,
      reportsUsage: true,
      needsRuntime: true,
    },
    personalUseOnly: false,
    pickerOrder: 0,
    failure,

    invalidate,
    models,

    /** From the runtime's catalog (`inputModalities`); the runner reads it again for each Send. */
    async vision() {
      let enabled = false
      try {
        const catalog = await models()
        enabled =
          catalog.options.find((option) => option.id === catalog.selectedModel)?.imageInput === true
      } catch {
        // No catalog: nobody said this model reads images.
      }
      return { enabled, source: 'model', setting: false, configurable: false }
    },

    async setModel(model) {
      const catalog = await models()
      if (model !== null && !catalog.options.some((option) => option.id === model))
        throw new SubscriptionError('model_unavailable', 'Choose an available Codex model.')
      await host.settings?.setSelection(id, model)
      invalidate()
      resolved = undefined
      lastFailure = undefined
      return {
        ...catalog,
        savedModel: model,
        selectedModel: model ?? catalog.defaultModel,
        resolvedModel: null,
      }
    },

    allowance() {
      const last = lastFailure
      return metadata(async (peer): Promise<ProviderAllowance> => ({
        ...(await codexAllowance(peer)),
        lastError: failureCopy(last),
      }))
    },

    async status(signal) {
      const check = host.track(signal)
      let signedIn: boolean | undefined
      try {
        const context = await host.context('codex', check.signal)
        let ready = false
        let allowance: ProviderAllowance | undefined
        const peer = await connectCodex(context, check.signal)
        try {
          ready = await codexAccount(peer)
          signedIn = ready
          if (ready) {
            try {
              allowance = await codexAllowance(peer)
            } catch {
              /* Allowance is advisory; signed-in chat remains usable. */
            }
          }
        } finally {
          peer.close()
        }
        if (ready && allowance?.state === 'limited') {
          const resetsAt = allowance.resetsAt ?? undefined
          return limitedStatus(id, failure({ code: 'usage_limit', resetsAt }), resetsAt)
        }
        return signedInStatus(id, ready, allowance)
      } catch (error) {
        return failedStatus(id, error, signedIn, failure)
      } finally {
        check.done()
      }
    },

    async login(session) {
      const context = await host.context('codex', session.signal)
      session.signal.throwIfAborted()
      const peer = await connectCodex(context, session.signal)
      await codexLogin(peer, host.openUrl, session.signal)
      lastFailure = undefined
    },

    async runner(tools, signal) {
      const context = await host.context('codex', signal)
      return createCodexRunner(context, tools, {
        model: host.settings?.selection(id) ?? null,
        catalog: (peer) => readCatalog(peer),
        onResolvedModel: (model) => {
          resolved = model
        },
        onAvailable: () => {
          lastFailure = undefined
        },
        onFailure: (next) => {
          lastFailure = next
        },
      })
    },
  }
  return adapter
}
