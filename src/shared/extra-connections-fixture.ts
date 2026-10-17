import { BUILTIN_CONNECTION_INFO } from './connections-fixture'
import type { ConnectionInfo } from './ipc-connections'

const apiKey = (
  id: string,
  vendor: ConnectionInfo['vendor'],
  title: string,
  extra: Partial<ConnectionInfo> = {},
): ConnectionInfo => ({
  id,
  vendor,
  access: 'api-key',
  label: `${title} · API`,
  shortLabel: title,
  title: `${title} API`,
  description: 'Use your own API key.',
  capabilities: {
    authKind: 'api-key',
    listsModels: true,
    reportsUsage: false,
    needsRuntime: false,
  },
  personalUseOnly: false,
  pickerOrder: 3,
  ...extra,
})

const local = (id: string, title: string): ConnectionInfo => ({
  id,
  vendor: 'local',
  access: 'free',
  label: `${title} · Local`,
  shortLabel: title,
  title,
  description: `Models running on this PC with ${title}.`,
  capabilities: { authKind: 'local', listsModels: true, reportsUsage: false, needsRuntime: false },
  personalUseOnly: false,
  pickerOrder: 5,
})

/**
 * Test data: the connections the new-connections work registers, as the renderer sees them
 * (the real list comes from main). The wizard is data-driven, so these only need
 * the shape; the Gemini notice is the free-key data-use warning.
 */
export const EXTRA_CONNECTION_INFO: ConnectionInfo[] = [
  apiKey('openai-api', 'openai', 'OpenAI'),
  {
    ...apiKey('gemini-api', 'google', 'Gemini'),
    notice: 'Free Gemini keys may let Google use your prompts to improve its products.',
  } as ConnectionInfo,
  local('ollama', 'Ollama'),
  local('lmstudio', 'LM Studio'),
  apiKey('openrouter-api', 'openrouter', 'OpenRouter'),
]

export const ALL_CONNECTION_INFO: ConnectionInfo[] = [
  ...BUILTIN_CONNECTION_INFO,
  ...EXTRA_CONNECTION_INFO,
]
