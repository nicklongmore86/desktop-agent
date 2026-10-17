import { GEMINI_API } from '../../../shared/ipc-connections'
import {
  createGeminiClient,
  GEMINI_FREE_TIER_NOTICE,
  geminiErrorEvent,
  listGeminiModels,
  validateGeminiKey,
} from '../../llm/gemini'
import { modelApiAdapter } from './model-api'

/** Ids that list generateContent but cannot run a chat tool loop. */
const NOT_CHAT = /(^|-)(embedding|aqa|imagen|veo|tts|image|live|audio|native-audio)(-|$)/

/**
 * Gemini by API key (free AI Studio keys or paid), sent only to
 * generativelanguage.googleapis.com. Google-account sign-in is not supported.
 */
export const geminiApiAdapter = (options: { fetch?: typeof fetch } = {}) => {
  const fetchOption = options.fetch ? { fetch: options.fetch } : {}
  return modelApiAdapter({
    id: GEMINI_API,
    vendor: 'google',
    access: 'api-key',
    label: 'Gemini · API',
    shortLabel: 'Gemini',
    title: 'Gemini API',
    description: 'Use a Gemini API key from Google AI Studio. Free keys work, with limits.',
    capabilities: {
      authKind: 'api-key',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 4,
    notice: `${GEMINI_FREE_TIER_NOTICE.title}. ${GEMINI_FREE_TIER_NOTICE.text}`,
    client: ({ key, model }) => createGeminiClient({ apiKey: key ?? '', model, ...fetchOption }),
    async list({ key, signal }) {
      const models = await listGeminiModels(key ?? '', { signal, ...fetchOption })
      return models
        .filter((model) => !NOT_CHAT.test(model.id))
        .map((model) => ({ id: model.id, label: model.displayName }))
    },
    async checkKey({ key, signal }) {
      const result = await validateGeminiKey(key, { signal, ...fetchOption })
      if (result.ok) return null
      const { code, message } = geminiErrorEvent(result.error)
      return { code, message }
    },
    errorEvent: geminiErrorEvent,
    // Flash first: it is on the free tier and quick enough for a tool loop.
    recommended: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-pro'],
    readyMessage: () =>
      'Gemini API mode uses your saved key. Free-tier keys share your data with Google.',
    missingKeyMessage: 'Add your Gemini API key in Settings.',
    noModelsMessage: 'This Gemini key has no chat models available.',
  })
}

export const createGeminiApiAdapter = geminiApiAdapter()
