import {
  createOpenAICompatClient,
  DEFAULT_BASE_URLS,
  listOpenAICompatModels,
  openAICompatErrorEvent,
  resolveBaseUrl,
  validateOpenAICompatKey,
  type FetchLike,
  type OpenAICompatFlavor,
} from '../../llm/openai-compat'
import type { ModelApiSpec } from './model-api'

/** Tests only: serve the pinned hosts from a local server. */
export interface AdapterTestOptions {
  fetch?: FetchLike
}

/**
 * The parts of a ModelApiSpec every Chat Completions connection shares. Hosted flavors
 * always use their one pinned https host (resolveBaseUrl refuses any other), so a key
 * only ever goes there; local flavors use the saved loopback root and send no key.
 */
export function compatSpec(
  flavor: OpenAICompatFlavor,
  options: AdapterTestOptions = {},
): Pick<ModelApiSpec, 'client' | 'list' | 'checkKey' | 'errorEvent' | 'listsVision'> {
  const hosted = flavor === 'openai' || flavor === 'openrouter'
  const connection = (key: string | null, baseUrl: string) => ({
    flavor,
    baseUrl: hosted ? DEFAULT_BASE_URLS[flavor] : baseUrl,
    ...(hosted && key ? { apiKey: key } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return {
    client: ({ key, model, baseUrl }) =>
      createOpenAICompatClient({ ...connection(key, baseUrl), model }),
    async list({ key, baseUrl, signal, timeoutMs }) {
      const models = await listOpenAICompatModels({
        ...connection(key, baseUrl),
        signal,
        timeoutMs,
      })
      return models.map((model) => ({
        id: model.id,
        label: model.name ?? model.id,
        toolSupport: model.toolSupport,
        ...(model.vision !== undefined ? { vision: model.vision } : {}),
      }))
    },
    ...(hosted
      ? {
          async checkKey({ key, baseUrl, signal, timeoutMs }) {
            const result = await validateOpenAICompatKey({
              ...connection(key, baseUrl),
              signal,
              timeoutMs,
            })
            return result.ok ? null : { code: result.code, message: result.message }
          },
        }
      : {}),
    errorEvent: openAICompatErrorEvent,
    // Only OpenRouter's list says which models read images (architecture.input_modalities).
    ...(flavor === 'openrouter' ? { listsVision: true } : {}),
  }
}

/** A local server's API root: loopback http only. Throws a safe message otherwise. */
export function loopbackRoot(flavor: OpenAICompatFlavor) {
  return {
    resolve: (baseUrl: string): string => {
      const url = resolveBaseUrl(baseUrl, flavor)
      return `${url.origin}${url.pathname}`
    },
  }
}
