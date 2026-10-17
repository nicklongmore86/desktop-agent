import { geminiFetch } from './client'
import { GeminiError } from './errors'

export interface GeminiModel {
  /** The id to pass as `model`, without the `models/` prefix. */
  id: string
  displayName: string
  inputTokenLimit?: number
  outputTokenLimit?: number
}

const PAGE_SIZE = 1000
const MAX_PAGES = 10

/**
 * The models the key can call with `generateContent`, via `models.list`
 * (https://ai.google.dev/api/models#method:-models.list). This is also how a key
 * is validated: listing models costs nothing, a generation would spend quota.
 * Throws GeminiError (`authentication` for a bad key).
 */
export async function listGeminiModels(
  apiKey: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<GeminiModel[]> {
  if (!apiKey.trim()) throw new GeminiError('authentication', 'Enter a Gemini API key.')
  const signal = options.signal ?? AbortSignal.timeout(30_000)
  const models: GeminiModel[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) })
    if (pageToken) query.set('pageToken', pageToken)
    const response = await geminiFetch(
      options.fetch ?? fetch,
      `/v1beta/models?${query.toString()}`,
      apiKey,
      {
        method: 'GET',
        signal,
      },
    )
    let body: { models?: unknown; nextPageToken?: unknown }
    try {
      body = (await response.json()) as typeof body
    } catch {
      throw new GeminiError('protocol', 'Gemini sent an unreadable model list.')
    }
    for (const raw of Array.isArray(body.models) ? (body.models as unknown[]) : []) {
      if (typeof raw !== 'object' || raw === null) continue
      const m = raw as Record<string, unknown>
      const methods = Array.isArray(m.supportedGenerationMethods)
        ? m.supportedGenerationMethods
        : []
      if (typeof m.name !== 'string' || !methods.includes('generateContent')) continue
      const id = m.name.replace(/^models\//, '')
      const model: GeminiModel = {
        id,
        displayName: typeof m.displayName === 'string' && m.displayName ? m.displayName : id,
      }
      if (typeof m.inputTokenLimit === 'number') model.inputTokenLimit = m.inputTokenLimit
      if (typeof m.outputTokenLimit === 'number') model.outputTokenLimit = m.outputTokenLimit
      models.push(model)
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined
    if (!pageToken) break
  }
  return models
}

/** Checks a key with `models.list` only; never runs a generation. */
export async function validateGeminiKey(
  apiKey: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<{ ok: true; models: GeminiModel[] } | { ok: false; error: GeminiError }> {
  try {
    return { ok: true, models: await listGeminiModels(apiKey, options) }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof GeminiError
          ? error
          : new GeminiError('api', 'The Gemini request failed. Please try again.'),
    }
  }
}
