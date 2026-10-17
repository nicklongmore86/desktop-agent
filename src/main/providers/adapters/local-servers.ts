import { LMSTUDIO, OLLAMA } from '../../../shared/ipc-connections'
import { DEFAULT_BASE_URLS } from '../../llm/openai-compat'
import { compatSpec, loopbackRoot, type AdapterTestOptions } from './compat'
import { modelApiAdapter, type ModelApiSpec } from './model-api'

const local = {
  vendor: 'local',
  access: 'free',
  capabilities: {
    authKind: 'local',
    listsModels: true,
    reportsUsage: false,
    needsRuntime: false,
  },
  personalUseOnly: false,
  // The user's own models: the first one the server lists unless they choose.
  recommended: [],
  missingKeyMessage: '',
} as const satisfies Partial<ModelApiSpec>

const models = (count: number): string => `${String(count)} model${count === 1 ? '' : 's'}`

/** Ollama on this computer: no key, loopback only (127.0.0.1:11434 unless changed). */
export const ollamaAdapter = (options: AdapterTestOptions = {}) =>
  modelApiAdapter({
    ...local,
    id: OLLAMA,
    label: 'Ollama · Local',
    shortLabel: 'Ollama',
    title: 'Ollama',
    description: 'Run open models on this computer with Ollama. Free; nothing leaves your PC.',
    pickerOrder: 6,
    defaultBaseUrl: DEFAULT_BASE_URLS.ollama,
    baseUrlRule: loopbackRoot('ollama'),
    ...compatSpec('ollama', options),
    readyMessage: (count) => `Ollama is running with ${models(count)}.`,
    unreachableMessage:
      "Ollama isn't running. Install it from ollama.com, start it, then check again.",
    noModelsMessage:
      'Ollama is running but has no models. Pull one (for example `ollama pull qwen3`), then check again.',
    modelWarning:
      "Ollama doesn't say which models can use tools. If the agent can't work with your files, choose a model that supports tool calling.",
  })

/** LM Studio's local server: no key, loopback only (127.0.0.1:1234 unless changed). */
export const lmStudioAdapter = (options: AdapterTestOptions = {}) =>
  modelApiAdapter({
    ...local,
    id: LMSTUDIO,
    label: 'LM Studio · Local',
    shortLabel: 'LM Studio',
    title: 'LM Studio',
    description: 'Run open models on this computer with LM Studio. Free; nothing leaves your PC.',
    pickerOrder: 7,
    defaultBaseUrl: DEFAULT_BASE_URLS.lmstudio,
    baseUrlRule: loopbackRoot('lmstudio'),
    ...compatSpec('lmstudio', options),
    readyMessage: (count) => `LM Studio is running with ${models(count)}.`,
    unreachableMessage:
      "LM Studio isn't running. Install it from lmstudio.ai, start its local server, then check again.",
    noModelsMessage: 'LM Studio is running but has no models loaded. Load one, then check again.',
    modelWarning:
      "LM Studio doesn't say which models can use tools. If the agent can't work with your files, choose a model that supports tool calling.",
  })

export const createOllamaAdapter = ollamaAdapter()
export const createLmStudioAdapter = lmStudioAdapter()
