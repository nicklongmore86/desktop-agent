import type { AccessType, ConnectionId, ConnectionInfo } from './ipc-connections'

/**
 * What the onboarding wizard offers: which AI the user wants, and how they want
 * to use it. A small static table says which of the two map to a connection and
 * which are known not to work (with the reason and the next step). The connections
 * themselves still come from connections.list(), so a connection that main does
 * not offer (not in this build, or hidden as personal use) never shows as usable.
 */

export const PROVIDER_KEYS = ['claude', 'chatgpt', 'gemini', 'local', 'openrouter'] as const
export type ProviderKey = (typeof PROVIDER_KEYS)[number]

export interface ProviderCard {
  key: ProviderKey
  name: string
  /** Second line on the card. */
  blurb: string
  /** Who bills the user ("Billed per use to your {vendor} account."). */
  vendorName: string
}

export const PROVIDER_CARDS: readonly ProviderCard[] = [
  { key: 'claude', name: 'Claude', blurb: 'Anthropic', vendorName: 'Anthropic' },
  { key: 'chatgpt', name: 'ChatGPT', blurb: 'OpenAI', vendorName: 'OpenAI' },
  { key: 'gemini', name: 'Gemini', blurb: 'Google', vendorName: 'Google' },
  {
    key: 'local',
    name: 'Local models',
    blurb: 'Ollama or LM Studio, runs on this PC',
    vendorName: 'this PC',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    blurb: 'Many models, one key',
    vendorName: 'OpenRouter',
  },
]

export const ACCESS_LABELS: Record<AccessType, string> = {
  free: 'Free',
  subscription: 'Subscription',
  'api-key': 'API key',
}

/** What one provider + access type does: use these connections, or why it cannot be used. */
type Cell =
  | {
      use: readonly ConnectionId[]
      note?: string
      /** Main hides these when showPersonalUseConnections is off; so does the wizard. */
      personalUse?: true
    }
  | {
      blocked: string
      /** Where to go instead: another access type of the same provider. */
      instead?: { access: AccessType; label: string }
    }

const GEMINI_BLOCKED =
  'Google doesn’t allow other apps to use your Google sign-in for Gemini. Use a free Gemini API key from Google AI Studio instead.'
const GEMINI_FREE_INSTEAD = { access: 'api-key', label: 'Use a free Gemini API key' } as const
const GEMINI_SUBSCRIPTION_INSTEAD = { access: 'api-key', label: 'Use a Gemini API key' } as const

/**
 * Segments that do not apply to a provider are left out (hidden), not disabled.
 * Local models only have "Free".
 */
export const ACCESS_MATRIX: Record<ProviderKey, Partial<Record<AccessType, Cell>>> = {
  claude: {
    free: {
      blocked:
        'Claude Free doesn’t include Claude Code, which this app uses for subscriptions. Use Claude Pro or Max, an Anthropic API key, or another provider.',
      instead: { access: 'api-key', label: 'Use an Anthropic API key' },
    },
    subscription: { use: ['claude-subscription'], personalUse: true },
    'api-key': { use: ['anthropic-api'] },
  },
  chatgpt: {
    free: { use: ['codex-subscription'], note: 'ChatGPT Free includes limited Codex use.' },
    subscription: { use: ['codex-subscription'] },
    'api-key': { use: ['openai-api'] },
  },
  gemini: {
    free: { blocked: GEMINI_BLOCKED, instead: GEMINI_FREE_INSTEAD },
    subscription: { blocked: GEMINI_BLOCKED, instead: GEMINI_SUBSCRIPTION_INSTEAD },
    'api-key': { use: ['gemini-api'], note: 'A free key from Google AI Studio works here.' },
  },
  local: {
    free: { use: ['ollama', 'lmstudio'] },
  },
  openrouter: {
    free: {
      use: ['openrouter-api'],
      note: 'OpenRouter lists some free models. You still need a key, and free models have their own limits.',
    },
    'api-key': { use: ['openrouter-api'] },
  },
}

/** Where to get a key, and what it looks like. Opened in the user's browser. */
export const KEY_HELP: Partial<Record<ConnectionId, { url: string; placeholder: string }>> = {
  'anthropic-api': { url: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  'openai-api': { url: 'https://platform.openai.com/api-keys', placeholder: 'sk-…' },
  'gemini-api': { url: 'https://aistudio.google.com/app/apikey', placeholder: 'AIza…' },
  'openrouter-api': { url: 'https://openrouter.ai/keys', placeholder: 'sk-or-…' },
}

export interface AccessOption {
  access: AccessType
  label: string
  available: boolean
  /** The connections to choose from (more than one only for local models). */
  connections: ConnectionInfo[]
  /** The cost line for an available option; the reason for an unavailable one. */
  text: string
  /** What the user can do next instead, for an unavailable option. */
  instead?: { access: AccessType; label: string }
  /** Extra line for an available option ("ChatGPT Free includes limited Codex use."). */
  note?: string
}

export interface AccessContext {
  connections: readonly ConnectionInfo[]
  showPersonalUse: boolean
}

const NOT_IN_BUILD = 'This isn’t available right now.'

function costLine(card: ProviderCard, access: AccessType, provider: ProviderKey): string {
  if (provider === 'local') return 'Runs on this PC. No account needed.'
  if (access === 'subscription') return 'Uses your plan’s limits. No API charges.'
  if (access === 'free') return 'Limited daily use.'
  if (provider === 'gemini')
    return 'A free key has limited daily use. A paid key is billed per use to your Google account.'
  return `Billed per use to your ${card.vendorName} account.`
}

/**
 * The access segments to show for a provider, in Free, Subscription, API key order.
 * An option is available when at least one of its connections is offered by main.
 * A personal-use connection main hides (showPersonalUseConnections off) hides its
 * segment too, rather than showing it disabled.
 */
export function accessOptions(provider: ProviderKey, context: AccessContext): AccessOption[] {
  const card = PROVIDER_CARDS.find((entry) => entry.key === provider)
  if (!card) return []
  const row = ACCESS_MATRIX[provider]
  const options: AccessOption[] = []
  for (const access of ['free', 'subscription', 'api-key'] as const) {
    const cell = row[access]
    if (!cell) continue
    const label = ACCESS_LABELS[access]
    if ('blocked' in cell) {
      options.push({
        access,
        label,
        available: false,
        connections: [],
        text: cell.blocked,
        ...(cell.instead ? { instead: cell.instead } : {}),
      })
      continue
    }
    const offered = cell.use.flatMap((id) => {
      const info = context.connections.find((entry) => entry.id === id)
      return info ? [info] : []
    })
    if (offered.length === 0) {
      // Hidden on purpose: do not advertise a connection the user turned off.
      if (cell.personalUse && !context.showPersonalUse) continue
      options.push({ access, label, available: false, connections: [], text: NOT_IN_BUILD })
      continue
    }
    options.push({
      access,
      label,
      available: true,
      connections: offered,
      text: costLine(card, access, provider),
      ...(cell.note ? { note: cell.note } : {}),
    })
  }
  return options
}

/** The provider card a connection belongs to, for starting the flow at an existing connection. */
export function providerOf(connection: ConnectionInfo): ProviderKey | null {
  for (const key of PROVIDER_KEYS)
    for (const cell of Object.values(ACCESS_MATRIX[key]))
      if ('use' in cell && cell.use.includes(connection.id)) return key
  return null
}

/** The access segment that names this connection (ChatGPT's two share Codex: Subscription wins). */
export function accessOf(provider: ProviderKey, id: ConnectionId): AccessType | null {
  const row = ACCESS_MATRIX[provider]
  for (const access of ['subscription', 'api-key', 'free'] as const) {
    const cell = row[access]
    if (cell && 'use' in cell && cell.use.includes(id)) return access
  }
  return null
}
