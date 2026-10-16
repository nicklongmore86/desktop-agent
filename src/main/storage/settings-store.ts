import { z } from 'zod'
import { PROVIDERS, type ProviderId, type ModelOption, type ModelSettings } from '../../shared/ipc'
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
  providerModels: Partial<Record<ProviderId, string>>
}

export interface SettingsStore {
  selection: (provider: ProviderId) => string | null
  setSelection: (provider: ProviderId, model: string | null) => Promise<void>
  readonly provider: ProviderId
  setProvider: (provider: ProviderId) => Promise<void>
  readonly model: string
  view: () => ModelSettings
  /** Throws for a model that is not offered. */
  setModel: (model: string) => Promise<ModelSettings>
}

const isOffered = (model: unknown): model is string =>
  typeof model === 'string' && MODEL_OPTIONS.some((option) => option.id === model)

/** Settings JSON in userData. A missing, unreadable or unknown value falls back to the default. */
export async function openSettingsStore(file: string): Promise<SettingsStore> {
  let model = DEFAULT_MODEL
  let provider: ProviderId = 'anthropic-api'
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
    selection: (id) => providerModels[id] ?? null,
    async setSelection(id, next) {
      if (!PROVIDERS.includes(id)) throw new Error('Unknown provider.')
      await serial(async () => {
        const selections = Object.fromEntries(
          Object.entries(providerModels).filter(([key]) => key !== id),
        )
        if (next !== null) selections[id] = next
        const validated = selectionSchema.parse(selections)
        await writeJsonFile(file, {
          version: 2,
          model,
          provider,
          providerModels: validated,
        } satisfies SettingsFile)
        providerModels = validated
      })
    },
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
          providerModels,
        } satisfies SettingsFile)
        provider = next
      })
    },
    get model() {
      return model
    },
    view,
    async setModel(next) {
      if (!isOffered(next)) throw new Error('Unknown model.')
      return serial(async () => {
        await writeJsonFile(file, {
          version: 2,
          model: next,
          provider,
          providerModels,
        } satisfies SettingsFile)
        model = next
        return view()
      })
    },
  }
}
