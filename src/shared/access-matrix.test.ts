import { describe, expect, it } from 'vitest'
import { ALL_CONNECTION_INFO } from './extra-connections-fixture'
import { BUILTIN_CONNECTION_INFO } from './connections-fixture'
import {
  ACCESS_MATRIX,
  PROVIDER_CARDS,
  PROVIDER_KEYS,
  accessOf,
  accessOptions,
  providerOf,
  type ProviderKey,
} from './access-matrix'

const all = { connections: ALL_CONNECTION_INFO, showPersonalUse: true }
const options = (provider: ProviderKey, context = all) => accessOptions(provider, context)
const pick = (provider: ProviderKey, access: string, context = all) =>
  options(provider, context).find((option) => option.access === access)

describe('access matrix', () => {
  it('has a card for every provider, in the order the wizard shows them', () => {
    expect(PROVIDER_CARDS.map((card) => card.key)).toEqual([...PROVIDER_KEYS])
    expect(PROVIDER_CARDS.map((card) => card.name)).toEqual([
      'Claude',
      'ChatGPT',
      'Gemini',
      'Local models',
      'OpenRouter',
    ])
  })

  it('shows the segments that apply, in Free, Subscription, API key order', () => {
    expect(options('claude').map((option) => option.access)).toEqual([
      'free',
      'subscription',
      'api-key',
    ])
    expect(options('chatgpt').map((option) => option.access)).toEqual([
      'free',
      'subscription',
      'api-key',
    ])
    expect(options('gemini').map((option) => option.access)).toEqual([
      'free',
      'subscription',
      'api-key',
    ])
    // Local models are only Free; OpenRouter has no subscription. The rest are hidden.
    expect(options('local').map((option) => option.access)).toEqual(['free'])
    expect(options('openrouter').map((option) => option.access)).toEqual(['free', 'api-key'])
  })

  it('keeps Claude Free visible but unavailable, with its reason and next step', () => {
    const free = pick('claude', 'free')
    expect(free).toMatchObject({ available: false, connections: [] })
    expect(free?.text).toBe(
      'Claude Free doesn’t include Claude Code, which this app uses for subscriptions. Use Claude Pro or Max, an Anthropic API key, or another provider.',
    )
    expect(free?.instead).toEqual({ access: 'api-key', label: 'Use an Anthropic API key' })
  })

  it('keeps Gemini Free and Subscription unavailable and points both at the API key', () => {
    const reason =
      'Google doesn’t allow other apps to use your Google sign-in for Gemini. Use a free Gemini API key from Google AI Studio instead.'
    for (const access of ['free', 'subscription']) {
      const cell = pick('gemini', access)
      expect(cell).toMatchObject({ available: false, text: reason })
      expect(cell?.instead?.access).toBe('api-key')
    }
    expect(pick('gemini', 'free')?.instead?.label).toBe('Use a free Gemini API key')
    expect(pick('gemini', 'api-key')).toMatchObject({
      available: true,
      connections: [expect.objectContaining({ id: 'gemini-api' })],
    })
  })

  it('maps both ChatGPT Free and Subscription to the Codex connection', () => {
    for (const access of ['free', 'subscription']) {
      expect(pick('chatgpt', access)?.connections.map((info) => info.id)).toEqual([
        'codex-subscription',
      ])
    }
    expect(pick('chatgpt', 'free')?.note).toBe('ChatGPT Free includes limited Codex use.')
  })

  it('offers Ollama and LM Studio under local models, and OpenRouter free through its key', () => {
    expect(pick('local', 'free')?.connections.map((info) => info.id)).toEqual([
      'ollama',
      'lmstudio',
    ])
    expect(pick('openrouter', 'free')).toMatchObject({
      available: true,
      connections: [expect.objectContaining({ id: 'openrouter-api' })],
    })
    expect(pick('openrouter', 'free')?.note).toMatch(/free models/)
  })

  it('writes the cost lines', () => {
    expect(pick('claude', 'subscription')?.text).toBe('Uses your plan’s limits. No API charges.')
    expect(pick('claude', 'api-key')?.text).toBe('Billed per use to your Anthropic account.')
    expect(pick('chatgpt', 'api-key')?.text).toBe('Billed per use to your OpenAI account.')
    expect(pick('openrouter', 'api-key')?.text).toBe('Billed per use to your OpenRouter account.')
    expect(pick('chatgpt', 'free')?.text).toBe('Limited daily use.')
    expect(pick('local', 'free')?.text).toBe('Runs on this PC. No account needed.')
  })

  it('hides the personal-use subscription when main leaves it out', () => {
    const hidden = {
      connections: ALL_CONNECTION_INFO.filter((info) => info.id !== 'claude-subscription'),
      showPersonalUse: false,
    }
    expect(options('claude', hidden).map((option) => option.access)).toEqual(['free', 'api-key'])
    // Shown setting but missing connection: visible, disabled, not a silent gap.
    const missing = { ...hidden, showPersonalUse: true }
    expect(pick('claude', 'subscription', missing)).toMatchObject({ available: false })
  })

  it('shows a connection this build does not have as unavailable instead of dropping it', () => {
    const builtins = { connections: BUILTIN_CONNECTION_INFO, showPersonalUse: true }
    expect(pick('gemini', 'api-key', builtins)).toMatchObject({ available: false })
    expect(pick('local', 'free', builtins)).toMatchObject({ available: false })
    expect(pick('local', 'free', builtins)?.text).toMatch(/isn’t available/)
    // Only the connections main lists can be used.
    expect(pick('claude', 'api-key', builtins)).toMatchObject({ available: true })
  })

  it('finds the card and segment for an existing connection', () => {
    const info = (id: string) => {
      const found = ALL_CONNECTION_INFO.find((entry) => entry.id === id)
      if (!found) throw new Error(`No fixture for ${id}`)
      return found
    }
    expect(providerOf(info('ollama'))).toBe('local')
    expect(providerOf(info('anthropic-api'))).toBe('claude')
    expect(accessOf('chatgpt', 'codex-subscription')).toBe('subscription')
    expect(accessOf('openrouter', 'openrouter-api')).toBe('api-key')
    expect(accessOf('claude', 'ollama')).toBeNull()
  })

  it('only names connection ids main could register', () => {
    for (const row of Object.values(ACCESS_MATRIX))
      for (const cell of Object.values(row))
        if ('use' in cell)
          for (const id of cell.use) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/)
  })
})
