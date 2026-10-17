import type { ConnectionInfo } from './ipc-connections'

/**
 * Test data: what main's registry lists for the built-in connections. The fakes
 * answer connections.list() with it; src/main/providers/registry.test.ts checks
 * it still matches the real adapters. Imported by tests only.
 */
export const BUILTIN_CONNECTION_INFO: ConnectionInfo[] = [
  {
    id: 'claude-subscription',
    vendor: 'anthropic',
    access: 'subscription',
    label: 'Claude · Subscription',
    shortLabel: 'Claude',
    title: 'Claude · Subscription',
    description: 'Sign in with your Claude account. No API key needed.',
    runtimeLabel: 'Claude Code',
    capabilities: {
      authKind: 'runtime-login',
      listsModels: false,
      reportsUsage: false,
      needsRuntime: true,
    },
    personalUseOnly: true,
    pickerOrder: 1,
  },
  {
    id: 'codex-subscription',
    vendor: 'openai',
    access: 'subscription',
    label: 'Codex · ChatGPT',
    shortLabel: 'Codex',
    title: 'Codex · ChatGPT',
    description: 'Sign in with your ChatGPT account. No API key needed.',
    runtimeLabel: 'Codex',
    capabilities: {
      authKind: 'runtime-login',
      listsModels: true,
      reportsUsage: true,
      needsRuntime: true,
    },
    personalUseOnly: false,
    pickerOrder: 0,
  },
  {
    id: 'anthropic-api',
    vendor: 'anthropic',
    access: 'api-key',
    label: 'Claude · API',
    shortLabel: 'Claude API',
    title: 'Anthropic API',
    description: 'Use your own API key.',
    capabilities: {
      authKind: 'api-key',
      listsModels: false,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 2,
  },
]
