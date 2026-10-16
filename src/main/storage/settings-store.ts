import { z } from 'zod'
import {
  PROVIDERS,
  THEMES,
  type ProviderId,
  type ModelOption,
  type ModelSettings,
  type ThemePreference,
} from '../../shared/ipc'
import { DEFAULT_LAYOUT, type LayoutPrefs } from '../../shared/ipc-layout'
import { DEFAULT_MODEL } from '../agent'
import { readJsonFile, writeJsonFile } from './json-file'
import { parseLayout } from './layout-schema'

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
  providerModels: Partial<Record<ProviderId, string>>
  /** Added later without a version bump: a missing or unknown value means 'system'. */
  theme?: ThemePreference
  /** Added later without a version bump: has its own version, and a missing or invalid one means the defaults. */
  layout?: LayoutPrefs
}

export interface SettingsStore {
  selection: (provider: ProviderId) => string | null
  setSelection: (provider: ProviderId, model: string | null) => Promise<void>
  readonly provider: ProviderId
  setProvider: (provider: ProviderId) => Promise<void>
  readonly model: string
  view: () => ModelSettings
  readonly theme: ThemePreference
  /** Throws for a theme that is not offered. */
  setTheme: (theme: ThemePreference) => Promise<ThemePreference>
  readonly layout: LayoutPrefs
  /** Validates (never throws): bad fields reset to their defaults, unknown keys are dropped. */
  setLayout: (layout: unknown) => Promise<LayoutPrefs>
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
  let layout: LayoutPrefs = { ...DEFAULT_LAYOUT }
  const selectionSchema = z.partialRecord(
    z.enum(PROVIDERS),
    z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  )
  let providerModels: Partial<Record<ProviderId, string>> = {}
  try {
    const parsed = (await readJsonFile(file)) as Partial<SettingsFile> | undefined
    if (parsed?.version === 2 && PROVIDERS.includes(parsed.provider as ProviderId))
      provider = parsed.provider as ProviderId
    const selections = selectionSchema.safeParse(parsed?.providerModels ?? {})
    if (selections.success) providerModels = selections.data
    if (isOffered(parsed?.model)) model = parsed.model
    if (THEMES.includes(parsed?.theme as ThemePreference)) theme = parsed?.theme as ThemePreference
    layout = parseLayout(parsed?.layout)
  } catch {
    // Keep the default.
  }
  let writes: Promise<unknown> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation)
    writes = result.catch(() => {})
    return result
  }
  /** The whole file with some fields changed: every write keeps the fields it does not touch. */
  const snapshot = (changes: Partial<SettingsFile>): SettingsFile => ({
    version: 2,
    model,
    provider,
    providerModels,
    theme,
    layout,
    ...changes,
  })
  const view = (): ModelSettings => ({
    model,
    defaultModel: DEFAULT_MODEL,
    options: MODEL_OPTIONS.map((option) => ({ ...option })),
  })
  return {
    selection: (id) => providerModels[id] ?? null,
    async setSelection(id, next) {
      if (!PROVIDERS.includes(id)) throw new Error('Unknown provider.')
      await serial(async () => {
        const selections = Object.fromEntries(
          Object.entries(providerModels).filter(([key]) => key !== id),
        )
        if (next !== null) selections[id] = next
        const validated = selectionSchema.parse(selections)
        await writeJsonFile(file, snapshot({ providerModels: validated }))
        providerModels = validated
      })
    },
    get provider() {
      return provider
    },
    async setProvider(next) {
      if (!PROVIDERS.includes(next)) throw new Error('Unknown provider.')
      await serial(async () => {
        await writeJsonFile(file, snapshot({ provider: next }))
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
        await writeJsonFile(file, snapshot({ theme: next }))
        theme = next
        return theme
      })
    },
    get layout() {
      return layout
    },
    async setLayout(next) {
      const validated = parseLayout(next)
      return serial(async () => {
        await writeJsonFile(file, snapshot({ layout: validated }))
        layout = validated
        return layout
      })
    },
    async setModel(next) {
      if (!isOffered(next)) throw new Error('Unknown model.')
      return serial(async () => {
        await writeJsonFile(file, snapshot({ model: next }))
        model = next
        return view()
      })
    },
  }
}
