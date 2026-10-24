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

/** An OpenAI dated snapshot suffix (`-2024-08-06`). */
const SNAPSHOT = String.raw`(-\d{4}-\d{2}-\d{2})?`
const exactly = (ids: string[]) => new RegExp(`^(${ids.join('|')})$`)

/**
 * OpenAI's documented image-input models, as exact ids or anchored patterns of their
 * published variants and snapshots: GPT-4o and GPT-4o mini, GPT-4.1 (mini, nano), GPT-4.5,
 * GPT-4 Turbo, GPT-5 and later (mini, nano, pro, codex, chat-latest), o1, o1-pro, o3,
 * o3-pro, o4-mini and codex-mini-latest. Another id of the same family (an audio, search,
 * realtime or transcribe model, or any other suffix) is not taken to read images.
 */
const OPENAI_SEES = exactly([
  'chatgpt-4o-latest',
  String.raw`gpt-4o(-mini)?${SNAPSHOT}`,
  String.raw`gpt-4\.1(-mini|-nano)?${SNAPSHOT}`,
  String.raw`gpt-4\.5-preview${SNAPSHOT}`,
  String.raw`gpt-4-turbo${SNAPSHOT}`,
  'gpt-4-vision-preview',
  String.raw`gpt-([5-9]|[1-9]\d)(\.\d{1,2})?(-mini|-nano|-pro|-codex(-mini|-max)?|-chat-latest)?${SNAPSHOT}`,
  String.raw`o1(-pro)?${SNAPSHOT}`,
  String.raw`o3(-pro)?${SNAPSHOT}`,
  String.raw`o4-mini${SNAPSHOT}`,
  'codex-mini-latest',
])
/** Documented text-only OpenAI models. */
const OPENAI_BLIND = exactly([
  String.raw`gpt-3\.5-turbo(-\d{4}|-16k|-instruct)?`,
  String.raw`gpt-4(-\d{4}|-32k(-\d{4})?)?`,
  String.raw`gpt-4-(\d{4}-preview|turbo-preview)`,
  String.raw`o1-(mini|preview)${SNAPSHOT}`,
  String.raw`o3-mini${SNAPSHOT}`,
  'gpt-oss-(20b|120b)',
])

/**
 * OpenAI model ids (API ids and ChatGPT plan slugs) by the documented models above; null for
 * any other id, so a lookalike (`codex-mini-evil`, `gpt-4o-text`) is not taken to read
 * images. Use it only when the model list itself does not say.
 */
export function openAIVision(model: string): PublishedVision {
  const id = model.toLowerCase()
  if (OPENAI_BLIND.test(id)) return false
  if (OPENAI_SEES.test(id)) return true
  return null
}

const GEMINI_SEES = exactly([
  String.raw`gemini-(1\.5|2\.0|2\.5|[3-9](\.\d)?)-(pro|flash|flash-lite|flash-8b)(-image)?(-latest|-\d{3}|-exp(-\d{2}-\d{2}|-\d{4})?|-preview(-\d{2}-\d{2,4})?)?`,
  'gemini-(pro|flash|flash-lite)-latest',
  String.raw`gemini-exp-\d{4}`,
  String.raw`gemini(-1\.0)?-pro-vision(-latest|-\d{3})?`,
])

/**
 * Gemini API model ids: the Gemini 1.5 and later Pro, Flash, Flash-Lite and Flash-8B
 * models (their `-latest`, numbered, experimental and preview ids, and the `-latest`
 * aliases) read images, as does Gemini 1.0 Pro Vision; the other Gemini 1.0 models do
 * not. Other ids (TTS, embedding, live audio, Gemma) are not said either way.
 */
export function geminiVision(model: string): PublishedVision {
  const id = model.replace(/^models\//, '').toLowerCase()
  if (GEMINI_SEES.test(id)) return true
  if (/^gemini-1\.0-/.test(id)) return false
  return null
}
