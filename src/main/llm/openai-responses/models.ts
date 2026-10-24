import { OpenAICompatError, openAICompatErrorEvent } from '../openai-compat/errors'
import { getJson } from '../openai-compat/models'
import type { KeyValidation } from '../openai-compat/models'
import { MODEL_SLUG, RESPONSES_BASE_URL, type ChatGPTConnectionOptions } from './client'
import { LABEL, responsesStatusError } from './errors'

export interface ChatGPTModel {
  /** Sent as `model`. */
  slug: string
  /** Shown in the model picker. */
  displayName: string
  /** Whether the entry's `input_modalities` lists `image`; absent when the entry does not say. */
  vision?: boolean
}

const MAX_MODELS = 1000

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * GET /v1/models with the account's token: `models[]`, keeping `visibility: "list"` in the
 * server's order (models-and-inference.md, step 1). Never sends a completion.
 */
export async function listChatGPTModels(
  options: ChatGPTConnectionOptions & { signal?: AbortSignal },
): Promise<ChatGPTModel[]> {
  const body = record(
    await getJson(
      {
        baseUrl: RESPONSES_BASE_URL,
        flavor: 'openai',
        label: LABEL,
        getAccessToken: options.getAccessToken,
        statusError: responsesStatusError,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      'models',
    ),
  )
  if (!Array.isArray(body.models))
    throw new OpenAICompatError('protocol', `${LABEL} sent a malformed model list.`)
  const models: ChatGPTModel[] = []
  const seen = new Set<string>()
  for (const raw of body.models.slice(0, MAX_MODELS)) {
    const entry = record(raw)
    if (entry.visibility !== 'list') continue
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : ''
    if (!MODEL_SLUG.test(slug) || seen.has(slug)) continue
    seen.add(slug)
    const name = typeof entry.display_name === 'string' ? entry.display_name.trim() : ''
    const modalities = entry.input_modalities
    models.push({
      slug,
      displayName: name ? name.slice(0, 256) : slug,
      ...(Array.isArray(modalities) ? { vision: modalities.includes('image') } : {}),
    })
  }
  return models
}

/** Checks a token with the read-only model list, never a completion. */
export async function validateChatGPTToken(
  options: ChatGPTConnectionOptions & { signal?: AbortSignal },
): Promise<KeyValidation> {
  try {
    await listChatGPTModels(options)
    return { ok: true }
  } catch (error) {
    const { code, message } = openAICompatErrorEvent(error)
    return { ok: false, code, message }
  }
}
