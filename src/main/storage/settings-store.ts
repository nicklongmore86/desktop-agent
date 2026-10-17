import { z } from 'zod'
import {
  THEMES,
  type ModelOption,
  type ModelSettings,
  type ThemePreference,
} from '../../shared/ipc'
import {
  BUILTIN_CONNECTIONS,
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

/** A connection the user has set up. Room for per-connection settings (an endpoint, a name). */
export interface ConfiguredConnection {
  id: ConnectionId
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

const connectionIdSchema = z.string().regex(CONNECTION_ID)
const selectionSchema = z.partialRecord(
  connectionIdSchema,
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
)
const connectionsSchema = z.array(z.object({ id: connectionIdSchema })).max(64)
/** v2's provider ids: the built-in connection ids, unchanged. */
const V2_PROVIDERS: readonly string[] = BUILTIN_CONNECTIONS

const defaultConnections = (): ConfiguredConnection[] => BUILTIN_CONNECTIONS.map((id) => ({ id }))

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
      if (list.success) connections = list.data.map(({ id }) => ({ id }))
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
