import type { ConnectionVision } from '../../shared/ipc-connections'

/**
 * Whether a model reads images, as a connection knows it: from its own model list, from
 * the vendor's published model families, or for every model it offers. Null when nothing
 * says; then the connection's "This model can see images" setting decides (default off).
 */
export type PublishedVision = boolean | null

/** A connection that cannot say and offers no setting: images are never sent. */
export const NO_VISION: ConnectionVision = {
  enabled: false,
  source: 'connection',
  setting: false,
  configurable: false,
}

export function resolveVision(
  published: PublishedVision,
  options: { source: 'connection' | 'model'; configurable: boolean; setting: boolean },
): ConnectionVision {
  const { source, configurable, setting } = options
  if (published !== null) return { enabled: published, source, setting, configurable }
  return { enabled: configurable && setting, source: 'setting', setting, configurable }
}

/**
 * OpenAI model ids (API ids and ChatGPT plan slugs), by the families OpenAI documents:
 * GPT-4o, GPT-4.1, GPT-4.5, GPT-4 Turbo, GPT-5 and later, o1, o3 and o4-mini read images;
 * GPT-3.5, the original GPT-4, o1-mini, o1-preview, o3-mini and the open-weight gpt-oss do not.
 */
export function openAIVision(model: string): PublishedVision {
  const id = model.toLowerCase()
  if (/^(gpt-3\.5|gpt-4(-0\d{3}|-32k)?($|-0)|o1-mini|o1-preview|o3-mini|gpt-oss)/.test(id))
    return false
  if (
    /^(chatgpt-4o|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-([5-9]|\d{2,})|o1|o3|o4-mini|codex-mini)($|[-.])/.test(
      id,
    )
  )
    return true
  return null
}

/**
 * Gemini API model ids: Gemini 1.5 and later (and the `-latest` aliases) read images;
 * Gemini 1.0 text models do not. Gemma and others are not said either way.
 */
export function geminiVision(model: string): PublishedVision {
  const id = model.replace(/^models\//, '').toLowerCase()
  if (/^gemini-1\.0/.test(id)) return false
  if (/^gemini-(1\.5|[2-9]|\d{2,}|flash|pro|exp)($|[-.])/.test(id)) return true
  return null
}
