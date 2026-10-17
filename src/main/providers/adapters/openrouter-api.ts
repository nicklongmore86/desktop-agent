import { OPENROUTER_API } from '../../../shared/ipc-connections'
import { compatSpec, type AdapterTestOptions } from './compat'
import { modelApiAdapter } from './model-api'

/**
 * OpenRouter by API key, sent only to openrouter.ai. Its model list is public, so the
 * key is checked with GET /api/v1/key; only models that advertise tool use are listed.
 */
export const openRouterApiAdapter = (options: AdapterTestOptions = {}) =>
  modelApiAdapter({
    id: OPENROUTER_API,
    vendor: 'openrouter',
    access: 'api-key',
    label: 'OpenRouter · API',
    shortLabel: 'OpenRouter',
    title: 'OpenRouter API',
    description: 'Use your own OpenRouter key to reach many models. Billed by OpenRouter.',
    capabilities: {
      authKind: 'api-key',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 5,
    ...compatSpec('openrouter', options),
    recommended: [
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-4o-mini',
    ],
    readyMessage: () => 'OpenRouter mode uses your saved API key and OpenRouter credits.',
    missingKeyMessage: 'Add your OpenRouter API key in Settings.',
    noModelsMessage: 'OpenRouter lists no models that can use tools right now.',
  })

export const createOpenRouterApiAdapter = openRouterApiAdapter()
