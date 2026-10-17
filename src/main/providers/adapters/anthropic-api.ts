import { ANTHROPIC_API } from '../../../shared/ipc-connections'
import { apiErrorEvent, createClaudeClient, DEFAULT_MODEL } from '../../agent'
import { agentClientAdapter } from './agent-client'

/** Anthropic by API key: the user's own key and separate API billing, never a fallback. */
export const createAnthropicApiAdapter = agentClientAdapter({
  id: ANTHROPIC_API,
  vendor: 'anthropic',
  access: 'api-key',
  label: 'Claude · API',
  shortLabel: 'Claude API',
  title: 'Anthropic API',
  description: 'Use your own API key.',
  capabilities: {
    authKind: 'api-key',
    // Its models come from the Claude list in Settings (model:get), not provider.models().
    listsModels: false,
    reportsUsage: false,
    needsRuntime: false,
  },
  personalUseOnly: false,
  pickerOrder: 2,
  client: ({ key }) => createClaudeClient(key ?? ''),
  model: (host) => host.settings?.model ?? DEFAULT_MODEL,
  readyMessage: 'Anthropic API mode uses your saved API key and separate API billing.',
  missingKeyMessage: 'Add your Anthropic API key in Settings.',
  errorEvent: apiErrorEvent,
})
