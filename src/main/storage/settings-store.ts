import type { ModelOption, ModelSettings } from '../../shared/ipc'
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
  version: 1
  model: string
}

export interface SettingsStore {
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
  try {
    const parsed = (await readJsonFile(file)) as Partial<SettingsFile> | undefined
    if (isOffered(parsed?.model)) model = parsed.model
  } catch {
    // Keep the default.
  }
  const view = (): ModelSettings => ({
    model,
    defaultModel: DEFAULT_MODEL,
    options: MODEL_OPTIONS.map((option) => ({ ...option })),
  })
  return {
    get model() {
      return model
    },
    view,
    async setModel(next) {
      if (!isOffered(next)) throw new Error('Unknown model.')
      await writeJsonFile(file, { version: 1, model: next } satisfies SettingsFile)
      model = next
      return view()
    },
  }
}
