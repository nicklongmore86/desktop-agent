import type { ProviderFailure, ProviderModels, ProviderStatus } from '../../../shared/ipc'
import type { AgentClient, AgentEvent } from '../../agent'
import type {
  AdapterFactory,
  AdapterHost,
  ConnectionAdapter,
  ConnectionDescriptor,
} from '../connection'
import { SetupError } from '../errors'
import type { PublishedVision } from '../vision'
import { agentClientAdapter } from './agent-client'

/** One model a connection lists, already filtered to ones that can chat. */
export interface ListedModel {
  id: string
  label: string
  /** Absent: the server's list does not say (shown with the list's warning). */
  toolSupport?: 'supported' | 'unknown'
  /** Whether the list says the model reads images; absent when it does not say. */
  vision?: boolean
}

/** What a list or key check gets: the saved key (null for local servers) and the API root. */
export interface RequestContext {
  key: string | null
  baseUrl: string
  signal: AbortSignal
  /** Give up after this long without an answer. */
  timeoutMs: number
}

/**
 * A connection over the app's own agent loop that can list its models and check a key
 * without spending anything: OpenAI, Gemini, OpenRouter by API key, Ollama and LM Studio
 * on this computer. Built on agentClientAdapter; see docs/connections.md.
 */
export interface ModelApiSpec extends ConnectionDescriptor {
  client: (options: { key: string | null; model: string; baseUrl: string }) => AgentClient
  /** The models that can run the tool loop. Throws what errorEvent maps. */
  list: (context: RequestContext) => Promise<ListedModel[]>
  /** API keys only: a read-only check (never a completion). Resolves null for a working key. */
  checkKey?: (context: RequestContext & { key: string }) => Promise<ProviderFailure | null>
  /** Recommended defaults, best first; otherwise the first listed model. */
  recommended: readonly string[]
  errorEvent: (error: unknown) => Extract<AgentEvent, { type: 'error' }>
  /** The status line once the key works (or the server answers with `count` models). */
  readyMessage: (count: number) => string
  missingKeyMessage: string
  /** Local servers: shown when nothing answers at the base URL. */
  unreachableMessage?: string
  /** Shown when the list is empty. */
  noModelsMessage: string
  /** Shown with the model list (local servers do not say which models can use tools). */
  modelWarning?: string
  /**
   * Local servers: the base URL can be changed in Settings. `resolve` returns the
   * normalized root or throws a safe message (loopback http only).
   */
  baseUrlRule?: { resolve: (baseUrl: string) => string }
  /**
   * Whether `model` reads images by the vendor's published model families, checked before
   * the model list's own word. Absent or null: the list, then the user's setting, decide.
   */
  vision?: (model: string) => PublishedVision
  /** The model list says which models read images (ListedModel.vision): OpenRouter's does. */
  listsVision?: boolean
}

const STATUS_TIMEOUT_MS = 3_000
const LIST_TIMEOUT_MS = 15_000
const CACHE_MS = 60_000

/** The recommended model that is listed, else the first listed one. */
export function pickDefault(models: readonly ListedModel[], recommended: readonly string[]) {
  return recommended.find((id) => models.some((model) => model.id === id)) ?? models[0]?.id ?? null
}

export function modelApiAdapter(spec: ModelApiSpec): AdapterFactory {
  const {
    client,
    list,
    checkKey,
    recommended,
    readyMessage,
    unreachableMessage,
    noModelsMessage,
    modelWarning,
    baseUrlRule,
    vision,
    listsVision,
    ...rest
  } = spec
  const { id, missingKeyMessage } = spec
  const apiKey = spec.capabilities.authKind === 'api-key'

  return (host: AdapterHost): ConnectionAdapter => {
    let cache:
      { key: string | null; baseUrl: string; models: ListedModel[]; at: number } | undefined
    let checked: { key: string; failure: ProviderFailure | null; at: number } | undefined

    const baseUrl = (): string => host.settings?.baseUrl(id) ?? spec.defaultBaseUrl ?? ''

    /** The saved key, null for local servers; throws SetupError without one. */
    const readKey = async (): Promise<string | null> => {
      if (!apiKey) return null
      let key: string | null
      try {
        key = (await host.keys?.forConnection(id).get()) ?? null
      } catch (error) {
        throw new SetupError(
          'key_unreadable',
          error instanceof Error ? error.message : 'The saved API key cannot be read.',
        )
      }
      if (!key) throw new SetupError('no_api_key', missingKeyMessage)
      return key
    }

    const context = (key: string | null, signal: AbortSignal | undefined, timeoutMs: number) => ({
      key,
      baseUrl: baseUrl(),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
      timeoutMs,
    })

    const listModels = async (
      key: string | null,
      signal?: AbortSignal,
      { fresh = false, timeoutMs = LIST_TIMEOUT_MS } = {},
    ): Promise<ListedModel[]> => {
      const root = baseUrl()
      if (
        !fresh &&
        cache &&
        cache.key === key &&
        cache.baseUrl === root &&
        Date.now() - cache.at < CACHE_MS
      )
        return cache.models
      const models = await list(context(key, signal, timeoutMs))
      cache = { key, baseUrl: root, models, at: Date.now() }
      return models
    }

    const check = async (key: string, signal?: AbortSignal, timeoutMs = LIST_TIMEOUT_MS) => {
      if (!checkKey) return null
      if (checked && checked.key === key && Date.now() - checked.at < CACHE_MS)
        return checked.failure
      const failure = await checkKey({ ...context(key, signal, timeoutMs), key })
      // Remember a working or rejected key, not a network failure that may pass.
      if (!failure || failure.code === 'authentication' || failure.code === 'permission')
        checked = { key, failure, at: Date.now() }
      return failure
    }

    const invalidate = (): void => {
      cache = undefined
      checked = undefined
    }

    const models = async (): Promise<ProviderModels> => {
      const listed = await listModels(await readKey())
      const savedModel = host.settings?.selection(id) ?? null
      const defaultModel = pickDefault(listed, recommended)
      const selectedModel =
        savedModel && listed.some((model) => model.id === savedModel) ? savedModel : defaultModel
      return {
        provider: id,
        options: listed.map((model) => ({
          id: model.id,
          label: model.label,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          isDefault: model.id === defaultModel,
          ...(model.toolSupport ? { toolSupport: model.toolSupport } : {}),
          ...(model.vision !== undefined ? { imageInput: model.vision } : {}),
        })),
        selectedModel,
        savedModel,
        defaultModel,
        resolvedModel: selectedModel,
        ...(modelWarning ? { warning: modelWarning } : {}),
      }
    }

    const base = agentClientAdapter({
      ...rest,
      client: ({ key, model }) => client({ key, model, baseUrl: baseUrl() }),
      // The saved choice, or the recommended one of the listed models.
      model: async () => {
        const saved = host.settings?.selection(id)
        if (saved) return saved
        const chosen = pickDefault(await listModels(await readKey()), recommended)
        if (!chosen) throw new SetupError('model_unavailable', noModelsMessage)
        return chosen
      },
      readyMessage: readyMessage(0),
      // The model list's own word when it has one (from the cache when it is fresh), else
      // the vendor's documented models, else nothing: the setting decides.
      vision: async (model) => {
        if (listsVision) {
          const listed = await readKey()
            .then((key) => listModels(key))
            .catch(() => [])
          const said = listed.find((candidate) => candidate.id === model)?.vision
          if (said !== undefined) return said
        }
        return vision?.(model) ?? null
      },
      visionSource: 'model',
      visionSetting: true,
    })(host)

    const errorStatus = (failure: ProviderFailure): ProviderStatus => ({
      provider: id,
      state: failure.code === 'no_api_key' ? 'signed-out' : 'error',
      ...(apiKey && (failure.code === 'no_api_key' || failure.code === 'authentication')
        ? { signedIn: false }
        : {}),
      message: failure.message,
      failure,
    })

    return {
      ...base,
      invalidate,
      models,
      async setModel(model) {
        const catalog = await models()
        if (model !== null && !catalog.options.some((option) => option.id === model))
          throw new SetupError('model_unavailable', `Choose an available ${spec.shortLabel} model.`)
        await host.settings?.setSelection(id, model)
        const selectedModel = model ?? catalog.defaultModel
        return { ...catalog, savedModel: model, selectedModel, resolvedModel: selectedModel }
      },

      async status(signal) {
        const tracked = host.track(signal)
        const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS)
        const both = AbortSignal.any([tracked.signal, timeout])
        try {
          const key = await readKey()
          if (key !== null) {
            const failure = await check(key, both)
            return failure
              ? errorStatus(failure)
              : { provider: id, state: 'ready', signedIn: true, message: readyMessage(0) }
          }
          // Always asks the server: "check again" must see it start or stop.
          const listed = await listModels(null, both, { fresh: true })
          if (!listed.length)
            return errorStatus({ code: 'model_unavailable', message: noModelsMessage })
          return { provider: id, state: 'ready', message: readyMessage(listed.length) }
        } catch (error) {
          if (tracked.signal.aborted && !timeout.aborted)
            return { provider: id, state: 'error', message: 'Check cancelled.' }
          const failure = base.failure(error)
          // A local server that does not answer is not running (or is somewhere else).
          if (
            unreachableMessage &&
            (timeout.aborted || failure.code === 'network' || failure.code === 'aborted')
          )
            return errorStatus({ code: 'runtime_unavailable', message: unreachableMessage })
          return errorStatus(failure)
        } finally {
          tracked.done()
        }
      },

      ...(checkKey
        ? {
            async validateKey(key: string, signal?: AbortSignal) {
              try {
                return await check(key, signal)
              } catch (error) {
                return base.failure(error)
              }
            },
          }
        : {}),

      ...(baseUrlRule
        ? {
            baseUrl: () => ({
              baseUrl: baseUrl(),
              custom: Boolean(host.settings?.baseUrl(id)),
            }),
            async setBaseUrl(next: string | null) {
              const resolved = next === null ? null : baseUrlRule.resolve(next)
              await host.settings?.setBaseUrl(
                id,
                resolved === spec.defaultBaseUrl ? null : resolved,
              )
              invalidate()
              return { baseUrl: baseUrl(), custom: Boolean(host.settings?.baseUrl(id)) }
            },
          }
        : {}),
    }
  }
}
