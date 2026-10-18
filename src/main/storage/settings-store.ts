import { z } from 'zod'
import {
  THEMES,
  type ModelOption,
  type ModelSettings,
  type ThemePreference,
} from '../../shared/ipc'
import {
  ANTHROPIC_API,
  CLAUDE_SUBSCRIPTION,
  CODEX_SUBSCRIPTION,
  CONNECTION_ID,
  DEFAULT_CONNECTION,
  type ConnectionId,
} from '../../shared/ipc-connections'
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

/** A connection the user has set up, with its per-connection settings. */
export interface ConfiguredConnection {
  id: ConnectionId
  /**
   * A local server's API root, when it is not the default. Saved only after main's
   * loopback check; checked again (resolveBaseUrl) before every request.
   */
  baseUrl?: string
}

/**
 * settings.json. Version 3 replaced v2's `provider` and `providerModels` with
 * `connection` and `connectionModels` (the ids did not change) and added
 * `connections` and `showPersonalUseConnections`. Older files are read and
 * migrated in memory; the first write saves version 3.
 */
interface SettingsFile {
  version: 3
  model: string
  /** The connection chats go to. Main checks it against the registry when it opens. */
  connection: ConnectionId
  /** Each connection's saved model choice. */
  connectionModels: Partial<Record<ConnectionId, string>>
  connections: ConfiguredConnection[]
  /** Offer connections that are for personal use only (see docs/connections.md). */
  showPersonalUseConnections: boolean
  /** Added later without a version bump: a missing or unknown value means 'system'. */
  theme?: ThemePreference
  /** Added later without a version bump: has its own version, and a missing or invalid one means the defaults. */
  layout?: LayoutPrefs
}

export interface SettingsStore {
  selection: (connection: ConnectionId) => string | null
  setSelection: (connection: ConnectionId, model: string | null) => Promise<void>
  readonly connection: ConnectionId
  /** Also adds it to the configured connections when it is not there yet. */
  setConnection: (connection: ConnectionId) => Promise<void>
  readonly connections: readonly ConfiguredConnection[]
  addConnection: (connection: ConnectionId) => Promise<void>
  /** Throws for the current connection: chats go there, so it cannot be taken out. */
  removeConnection: (connection: ConnectionId) => Promise<void>
  /** A connection's saved API root, or null for its default. */
  baseUrl: (connection: ConnectionId) => string | null
  /** Saves an API root the caller has validated (null: back to the default). */
  setBaseUrl: (connection: ConnectionId, baseUrl: string | null) => Promise<void>
  readonly showPersonalUseConnections: boolean
  setShowPersonalUseConnections: (show: boolean) => Promise<void>
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

/**
 * A model id a connection may list: OpenRouter's `vendor/model:variant`, Ollama's
 * `name:tag`, LM Studio's `name@quant`. Never part of a path, and nothing shaped like
 * one (a drive, `..`, `//`) is accepted anyway.
 */
export const MODEL_ID = /^(?![a-zA-Z]:\/)(?!.*(?:\.\.|\/\/))[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/

const connectionIdSchema = z.string().regex(CONNECTION_ID)
const selectionSchema = z.partialRecord(connectionIdSchema, z.string().regex(MODEL_ID))
const baseUrlSchema = z.string().min(1).max(2048)
const connectionsSchema = z
  .array(z.object({ id: connectionIdSchema, baseUrl: baseUrlSchema.optional() }))
  .max(64)
/** v2's provider ids: the first three connection ids, unchanged. */
const V2_PROVIDERS: readonly string[] = [CLAUDE_SUBSCRIPTION, CODEX_SUBSCRIPTION, ANTHROPIC_API]

/** The first three, as before; a newer connection is added once the user uses or sets it up. */
const defaultConnections = (): ConfiguredConnection[] => V2_PROVIDERS.map((id) => ({ id }))

/** Unique ids, the current connection included. */
function withConnection(
  list: readonly ConfiguredConnection[],
  id: ConnectionId,
): ConfiguredConnection[] {
  const seen = new Set<ConnectionId>()
  const unique = list.filter((entry) => !seen.has(entry.id) && seen.add(entry.id))
  return seen.has(id) ? unique : [...unique, { id }]
}

/** Settings JSON in userData. A missing, unreadable or unknown value falls back to the default. */
export async function openSettingsStore(file: string): Promise<SettingsStore> {
  let model = DEFAULT_MODEL
  let connection: ConnectionId = DEFAULT_CONNECTION
  let connections = defaultConnections()
  let showPersonalUseConnections = true
  let theme: ThemePreference = 'system'
  let layout: LayoutPrefs = { ...DEFAULT_LAYOUT }
  let connectionModels: Partial<Record<ConnectionId, string>> = {}
  try {
    const parsed = (await readJsonFile(file)) as Record<string, unknown> | undefined
    if (parsed?.['version'] === 3) {
      const saved = connectionIdSchema.safeParse(parsed['connection'])
      if (saved.success) connection = saved.data
      const list = connectionsSchema.safeParse(parsed['connections'])
      if (list.success)
        connections = list.data.map(({ id, baseUrl }) => ({ id, ...(baseUrl ? { baseUrl } : {}) }))
      if (typeof parsed['showPersonalUseConnections'] === 'boolean')
        showPersonalUseConnections = parsed['showPersonalUseConnections']
      const selections = selectionSchema.safeParse(parsed['connectionModels'] ?? {})
      if (selections.success) connectionModels = selections.data
    } else {
      // v2 (and v1, which had no provider): the old provider ids are the connection ids.
      if (parsed?.['version'] === 2 && V2_PROVIDERS.includes(parsed['provider'] as string))
        connection = parsed['provider'] as ConnectionId
      const selections = selectionSchema.safeParse(parsed?.['providerModels'] ?? {})
      if (selections.success) connectionModels = selections.data
    }
    connections = withConnection(connections, connection)
    if (isOffered(parsed?.['model'])) model = parsed['model']
    if (THEMES.includes(parsed?.['theme'] as ThemePreference))
      theme = parsed?.['theme'] as ThemePreference
    layout = parseLayout(parsed?.['layout'])
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
    version: 3,
    model,
    connection,
    connectionModels,
    connections,
    showPersonalUseConnections,
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
    selection: (id) => connectionModels[id] ?? null,
    async setSelection(id, next) {
      if (!CONNECTION_ID.test(id)) throw new Error('Unknown provider.')
      await serial(async () => {
        const selections = Object.fromEntries(
          Object.entries(connectionModels).filter(([key]) => key !== id),
        )
        if (next !== null) selections[id] = next
        const validated = selectionSchema.parse(selections)
        await writeJsonFile(file, snapshot({ connectionModels: validated }))
        connectionModels = validated
      })
    },
    get connection() {
      return connection
    },
    async setConnection(next) {
      if (!CONNECTION_ID.test(next)) throw new Error('Unknown provider.')
      await serial(async () => {
        const list = withConnection(connections, next)
        await writeJsonFile(file, snapshot({ connection: next, connections: list }))
        connection = next
        connections = list
      })
    },
    get connections() {
      return connections
    },
    async addConnection(next) {
      if (!CONNECTION_ID.test(next)) throw new Error('Unknown provider.')
      await serial(async () => {
        const list = withConnection(connections, next)
        await writeJsonFile(file, snapshot({ connections: list }))
        connections = list
      })
    },
    async removeConnection(id) {
      if (!CONNECTION_ID.test(id)) throw new Error('Unknown provider.')
      await serial(async () => {
        if (id === connection)
          throw new Error('Switch to another connection before removing this one.')
        const list = connections.filter((entry) => entry.id !== id)
        await writeJsonFile(file, snapshot({ connections: list }))
        connections = list
      })
    },
    baseUrl: (id) => connections.find((entry) => entry.id === id)?.baseUrl ?? null,
    async setBaseUrl(id, next) {
      if (!CONNECTION_ID.test(id)) throw new Error('Unknown provider.')
      if (next !== null && !baseUrlSchema.safeParse(next).success)
        throw new Error('Enter a shorter address.')
      await serial(async () => {
        // Never changes which connection chats go to.
        const list = withConnection(connections, id).map((entry) =>
          entry.id !== id ? entry : next === null ? { id } : { id, baseUrl: next },
        )
        await writeJsonFile(file, snapshot({ connections: list }))
        connections = list
      })
    },
    get showPersonalUseConnections() {
      return showPersonalUseConnections
    },
    async setShowPersonalUseConnections(show) {
      if (typeof show !== 'boolean') throw new Error('Invalid choice.')
      await serial(async () => {
        await writeJsonFile(file, snapshot({ showPersonalUseConnections: show }))
        showPersonalUseConnections = show
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
