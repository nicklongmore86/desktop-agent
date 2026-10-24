import type { AgentErrorCode } from '../../agent/types'
import { OpenAICompatError, openAICompatErrorEvent } from './errors'
import { connect, type ConnectionOptions } from './http'

export interface OpenAICompatModel {
  id: string
  name?: string
  contextLength?: number
  /** OpenRouter lists only models that advertise `tools`; other servers do not say. */
  toolSupport: 'supported' | 'unknown'
  /** OpenRouter: whether `architecture.input_modalities` lists `image`. Absent elsewhere. */
  vision?: boolean
}

const MAX_MODELS = 5000
const MAX_BODY = 32 * 1024 * 1024
/** OpenAI's /v1/models lists every model family; these cannot run a chat tool loop. */
const OPENAI_NON_CHAT =
  /^(text-embedding|embedding|whisper|tts|dall-e|gpt-image|omni-moderation|text-moderation|davinci|babbage|sora)|-(transcribe|tts|realtime|audio|search-api)(-|$)/

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export async function getJson(
  options: ConnectionOptions & { signal?: AbortSignal },
  endpoint: string,
): Promise<unknown> {
  const connection = connect(options)
  const { response, done, mapError } = await connection.request(endpoint, {
    method: 'GET',
    accept: 'application/json',
    ...(options.signal ? { signal: options.signal } : {}),
  })
  try {
    const length = Number(response.headers.get('content-length'))
    if (length > MAX_BODY)
      throw new OpenAICompatError('protocol', `${connection.label} sent an oversized model list.`)
    const text = await response.text()
    if (text.length > MAX_BODY)
      throw new OpenAICompatError('protocol', `${connection.label} sent an oversized model list.`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new OpenAICompatError('protocol', `${connection.label} sent a malformed model list.`)
    }
  } catch (error) {
    throw mapError(error)
  } finally {
    done()
  }
}

/** GET {base}/models. Never sends a completion. */
export async function listOpenAICompatModels(
  options: ConnectionOptions & { signal?: AbortSignal },
): Promise<OpenAICompatModel[]> {
  const body = record(await getJson(options, 'models'))
  const data = Array.isArray(body.data) ? body.data.slice(0, MAX_MODELS) : []
  const models: OpenAICompatModel[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    const entry = record(raw)
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id || id.length > 256 || seen.has(id)) continue
    if (options.flavor === 'openai' && OPENAI_NON_CHAT.test(id)) continue
    let toolSupport: OpenAICompatModel['toolSupport'] = 'unknown'
    let vision: boolean | undefined
    if (options.flavor === 'openrouter') {
      const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
      if (!params.includes('tools')) continue
      toolSupport = 'supported'
      const modalities = record(entry.architecture).input_modalities
      if (Array.isArray(modalities)) vision = modalities.includes('image')
    }
    seen.add(id)
    models.push({
      id,
      ...(typeof entry.name === 'string' && entry.name ? { name: entry.name.slice(0, 256) } : {}),
      ...(typeof entry.context_length === 'number' && entry.context_length > 0
        ? { contextLength: Math.floor(entry.context_length) }
        : {}),
      toolSupport,
      ...(vision !== undefined ? { vision } : {}),
    })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

export type KeyValidation = { ok: true } | { ok: false; code: AgentErrorCode; message: string }

/**
 * Checks the key with a read-only request, never a completion. OpenAI and local servers:
 * GET /models. OpenRouter's /models is public (it accepts any key), so its key is checked
 * with GET /key, which only returns the key's own metadata.
 */
export async function validateOpenAICompatKey(
  options: ConnectionOptions & { signal?: AbortSignal },
): Promise<KeyValidation> {
  try {
    await getJson(options, options.flavor === 'openrouter' ? 'key' : 'models')
    return { ok: true }
  } catch (error) {
    const { code, message } = openAICompatErrorEvent(error)
    return { ok: false, code, message }
  }
}
