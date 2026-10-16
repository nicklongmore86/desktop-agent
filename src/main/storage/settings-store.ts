import {
  PROVIDERS,
  THEMES,
  type ProviderId,
  type ModelOption,
  type ModelSettings,
  type ThemePreference,
} from '../../shared/ipc'
import { DEFAULT_MODEL } from '../agent'
import { readJsonFile, writeJsonFile } from './json-file'

/** Models offered in Settings. The default comes from the agent module. */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
]

interface SettingsFile {
  version: 2
  model: string
  provider: ProviderId
  /** Added later without a version bump: a missing or unknown value means 'system'. */
  theme?: ThemePreference
}

export interface SettingsStore {
  readonly provider: ProviderId
  setProvider: (provider: ProviderId) => Promise<void>
  readonly model: string
  view: () => ModelSettings
  readonly theme: ThemePreference
  /** Throws for a theme that is not offered. */
  setTheme: (theme: ThemePreference) => Promise<ThemePreference>
  /** Throws for a model that is not offered. */
  setModel: (model: string) => Promise<ModelSettings>
}

const isOffered = (model: unknown): model is string =>
  typeof model === 'string' && MODEL_OPTIONS.some((option) => option.id === model)

/** Settings JSON in userData. A missing, unreadable or unknown value falls back to the default. */
export async function openSettingsStore(file: string): Promise<SettingsStore> {
  let model = DEFAULT_MODEL
  let provider: ProviderId = 'anthropic-api'
  let theme: ThemePreference = 'system'
  try {
    const parsed = (await readJsonFile(file)) as Partial<SettingsFile> | undefined
    if (parsed?.version === 2 && PROVIDERS.includes(parsed.provider as ProviderId))
      provider = parsed.provider as ProviderId
    if (isOffered(parsed?.model)) model = parsed.model
    if (THEMES.includes(parsed?.theme as ThemePreference)) theme = parsed?.theme as ThemePreference
  } catch {
    // Keep the default.
  }
  let writes: Promise<unknown> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation)
    writes = result.catch(() => {})
    return result
  }
  const view = (): ModelSettings => ({
    model,
    defaultModel: DEFAULT_MODEL,
    options: MODEL_OPTIONS.map((option) => ({ ...option })),
  })
  return {
    get provider() {
      return provider
    },
    async setProvider(next) {
      if (!PROVIDERS.includes(next)) throw new Error('Unknown provider.')
      await serial(async () => {
        await writeJsonFile(file, {
          version: 2,
          model,
          provider: next,
          theme,
        } satisfies SettingsFile)
        provider = next
      })
    },
    get model() {
      return model
    },
    view,
    get theme() {
      return theme
    },
    async setTheme(next) {
      if (!THEMES.includes(next)) throw new Error('Unknown theme.')
      return serial(async () => {
        await writeJsonFile(file, {
          version: 2,
          model,
          provider,
          theme: next,
        } satisfies SettingsFile)
        theme = next
        return theme
      })
    },
    async setModel(next) {
      if (!isOffered(next)) throw new Error('Unknown model.')
      return serial(async () => {
        await writeJsonFile(file, {
          version: 2,
          model: next,
          provider,
          theme,
        } satisfies SettingsFile)
        model = next
        return view()
      })
    },
  }
}
