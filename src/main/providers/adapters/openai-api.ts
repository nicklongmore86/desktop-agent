import { OPENAI_API } from '../../../shared/ipc-connections'
import { openAIVision } from '../vision'
import { compatSpec, type AdapterTestOptions } from './compat'
import { modelApiAdapter } from './model-api'

/** OpenAI by API key: the user's own key, sent only to api.openai.com. */
export const openAIApiAdapter = (options: AdapterTestOptions = {}) =>
  modelApiAdapter({
    id: OPENAI_API,
    vendor: 'openai',
    access: 'api-key',
    label: 'OpenAI · API',
    shortLabel: 'OpenAI',
    title: 'OpenAI API',
    description: 'Use your own OpenAI API key. Billed by OpenAI.',
    capabilities: {
      authKind: 'api-key',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 3,
    ...compatSpec('openai', options),
    recommended: ['gpt-5.5', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
    readyMessage: () => 'OpenAI API mode uses your saved API key and separate API billing.',
    missingKeyMessage: 'Add your OpenAI API key in Settings.',
    noModelsMessage: 'This OpenAI key has no chat models available.',
    // OpenAI's model list does not say; its documented families do.
    vision: openAIVision,
  })

export const createOpenAIApiAdapter = openAIApiAdapter()
