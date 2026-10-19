import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConversationSummary, HistoryState } from '../../shared/ipc'
import {
  attachmentIdsIn,
  attachmentsOf,
  createConversationStore,
  isWellFormed,
  type ConversationStore,
  type StoredMessage,
} from './conversation-store'
import { readJsonFile, removeFile, writeJsonFile } from './json-file'
import { sanitizeTitle } from './plain-text'

export { MAX_TITLE_LENGTH, sanitizeTitle } from './plain-text'

/**
 * Conversation ids are random v4 UUIDs, made in main. A file path is only
 * ever built from an id that matches this, never from anything else.
 */
export const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Titles made from the first message are cut to this many characters. */
export const TITLE_LENGTH = 60

export const MESSAGES = {
  legacyUnreadable: 'The saved conversation could not be read, so a new one was started.',
  missing: 'The saved conversation could not be found, so a new one was started.',
  indexRebuilt: 'The chat history list could not be read, so it was rebuilt from the saved chats.',
  indexUnsaved: 'The chat history could not be saved to disk.',
} as const

/** The first thing the user typed (or, for a prompt of files only, attached), as a title. */
export function titleFrom(messages: readonly StoredMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')
    const title = sanitizeTitle(text || (attachmentsOf(message)[0]?.name ?? ''), TITLE_LENGTH)
    if (title) return title
  }
  return 'New chat'
}

export interface ConversationHistory {
  /** The open conversation, or null for a new chat that has not been saved yet. */
  readonly activeId: string | null
  state: () => HistoryState
  has: (id: string) => boolean
  /** The open conversation's store: its saved file, or a new draft. */
  current: () => ConversationStore
  /** The store of a saved conversation. Throws for an unknown id. */
  open: (id: string) => ConversationStore
  /** A new chat: nothing is written until its first save, which adds it to the list. */
  draft: () => ConversationStore
  /** Remembers which conversation is open. Never throws: losing this only matters at restart. */
  setActive: (id: string | null) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Sets a chat's pin, archive or project. Throws for an unknown id. */
  organize: (id: string, change: Organize) => Promise<void>
  /** Takes every chat out of a project (the project was deleted). */
  unfile: (projectId: string) => Promise<void>
  /**
   * Copies a saved chat into a new one titled "Fork of …" and returns its id.
   * `prompts`: keep only the first that many prompts and their replies (null: all).
   */
  fork: (id: string, prompts: number | null) => Promise<string>
}

/** What `organize` changes; a field left out stays as it is. */
export interface Organize {
  pinned?: boolean
  archived?: boolean
  projectId?: string | null
}

const idSchema = z.string().regex(CONVERSATION_ID)
const timeSchema = z.number().nonnegative()
/**
 * Index format 2 adds pin, archive, project and fork fields to each chat. It
 * keeps `version: 1` on disk because the previous build accepts only that and
 * would otherwise rebuild its list from the chat files, losing renamed titles;
 * that build's parser drops the new fields and reads the rest unchanged. A
 * format-1 index (no `format`) reads as format 2 with every new field unset,
 * and is written as format 2 on the next change. A new field that is not
 * valid reads as unset; it never makes the whole index unreadable.
 */
export const INDEX_FORMAT = 2
const lenient = <T extends z.ZodType>(schema: T) => schema.nullable().optional().catch(null)
const entrySchema = z.object({
  id: idSchema,
  title: z.string(),
  createdAt: timeSchema,
  updatedAt: timeSchema,
  pinnedAt: lenient(timeSchema),
  archivedAt: lenient(timeSchema),
  projectId: lenient(idSchema),
  forkedFrom: lenient(
    z.object({ id: idSchema, atMessageIndex: z.number().int().positive().nullable() }),
  ),
})
const indexSchema = z.object({
  version: z.literal(1),
  format: z.number().optional(),
  activeId: idSchema.nullable(),
  conversations: z.array(entrySchema),
})
type IndexFile = z.infer<typeof indexSchema>

export interface HistoryOptions {
  /** The single conversation file of earlier versions, moved into the history once. */
  legacyFile?: string
  newId?: () => string
  now?: () => number
  /** Index writes that fail where nobody is waiting for them (setActive), and failed releases. */
  onError?: (error: unknown) => void
  /**
   * Called after a chat file is deleted with the attachment ids it referenced.
   * Other chats (forks, other connections) may still use them: the callee
   * decides which are free (see `referencedAttachmentIds`).
   */
  releaseAttachments?: (ids: string[]) => Promise<void>
}

/** A summary without its unset optional fields, as the renderer and the index hold it. */
function withoutUnset(entry: z.infer<typeof entrySchema>): ConversationSummary {
  const { pinnedAt, archivedAt, projectId, forkedFrom, ...summary } = entry
  return {
    ...summary,
    ...(pinnedAt != null ? { pinnedAt } : {}),
    ...(archivedAt != null ? { archivedAt } : {}),
    ...(projectId != null ? { projectId } : {}),
    ...(forkedFrom != null ? { forkedFrom } : {}),
  }
}

/** The first `prompts` prompts and their replies: everything before the next prompt. */
export function keepPrompts(messages: StoredMessage[], prompts: number): StoredMessage[] | null {
  let seen = 0
  for (const [index, message] of messages.entries()) {
    if (!isPrompt(message)) continue
    seen += 1
    if (seen > prompts) return messages.slice(0, index)
  }
  return seen === prompts ? messages : null
}

/** A user message the user typed, not one that carries tool results back. */
function isPrompt(message: StoredMessage): boolean {
  if (message.role !== 'user') return false
  if (typeof message.content === 'string') return true
  return message.content.every((block) => block.type !== 'tool_result')
}

const byRecent = (a: ConversationSummary, b: ConversationSummary): number =>
  b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)

class FileHistory implements ConversationHistory {
  private readonly entries = new Map<string, ConversationSummary>()
  private active: string | null
  private writes: Promise<unknown> = Promise.resolve()
  private readonly newId: () => string
  private readonly now: () => number

  constructor(
    private readonly dir: string,
    index: Pick<IndexFile, 'activeId' | 'conversations'>,
    /** Shown once, by the first load after opening (see `takeWarning`). */
    private warning: string | null,
    private readonly options: HistoryOptions,
  ) {
    this.newId = options.newId ?? randomUUID
    this.now = options.now ?? Date.now
    for (const entry of index.conversations) {
      if (this.entries.has(entry.id)) continue
      this.entries.set(entry.id, {
        ...withoutUnset(entry),
        // The index is a file on disk: never trust that its titles are still plain text.
        title: sanitizeTitle(entry.title) || 'Untitled chat',
      })
    }
    this.active =
      index.activeId !== null && this.entries.has(index.activeId) ? index.activeId : null
  }

  get activeId(): string | null {
    return this.active
  }

  state(): HistoryState {
    return {
      conversations: [...this.entries.values()].sort(byRecent).map((entry) => ({ ...entry })),
      activeId: this.active,
    }
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  private file(id: string): string {
    if (!CONVERSATION_ID.test(id)) throw new Error('Invalid conversation id.')
    return join(this.dir, `${id}.json`)
  }

  private takeWarning(): string | null {
    const warning = this.warning
    this.warning = null
    return warning
  }

  current(): ConversationStore {
    return this.active === null ? this.draft() : this.open(this.active)
  }

  open(id: string): ConversationStore {
    if (!this.entries.has(id)) throw new Error('That chat no longer exists.')
    return this.storeFor(id)
  }

  draft(): ConversationStore {
    return this.storeFor(null)
  }

  private storeFor(initialId: string | null): ConversationStore {
    let id = initialId
    return {
      load: async () => {
        const warning = this.takeWarning()
        if (id === null) return { messages: [], error: warning }
        const loaded = await createConversationStore(this.file(id)).load()
        // A listed conversation always has messages: an empty one means its file is gone.
        const own = loaded.error ?? (loaded.messages.length === 0 ? MESSAGES.missing : null)
        const error = [warning, own].filter(Boolean).join(' ') || null
        return { messages: loaded.messages, error }
      },
      save: async (messages) => {
        if (id === null) id = this.newId()
        const saving = id
        await createConversationStore(this.file(saving)).save(messages)
        const now = this.now()
        const existing = this.entries.get(saving)
        this.entries.set(
          saving,
          existing
            ? { ...existing, updatedAt: now }
            : { id: saving, title: titleFrom(messages), createdAt: now, updatedAt: now },
        )
        // A draft's first save makes it the open conversation.
        if (initialId === null && this.active === null) this.active = saving
        await this.writeIndex()
      },
      clear: async () => {
        if (id !== null) await this.remove(id)
      },
    }
  }

  async setActive(id: string | null): Promise<void> {
    this.active = id !== null && this.entries.has(id) ? id : null
    await this.writeIndex().catch((error: unknown) => {
      this.options.onError?.(error)
    })
  }

  async rename(id: string, title: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('That chat no longer exists.')
    const clean = sanitizeTitle(title)
    if (!clean) throw new Error('Enter a name for the chat.')
    this.entries.set(id, { ...entry, title: clean })
    try {
      await this.writeIndex()
    } catch (error) {
      if (this.entries.get(id)?.title === clean) this.entries.set(id, entry)
      throw error
    }
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    const wasActive = this.active === id
    this.entries.delete(id)
    if (wasActive) this.active = null
    try {
      await this.writeIndex()
    } catch (error) {
      // Still listed on disk, so keep listing it.
      this.entries.set(id, entry)
      if (wasActive && this.active === null) this.active = id
      throw error
    }
    const file = this.file(id)
    // Read before the file goes: an unreadable one simply has nothing to report.
    const ids = this.options.releaseAttachments
      ? [...attachmentIdsIn(await readJsonFile(file).catch(() => undefined))]
      : []
    await removeFile(file)
    if (ids.length > 0)
      await this.options.releaseAttachments?.(ids).catch((error: unknown) => {
        this.options.onError?.(error)
      })
  }

  async organize(id: string, change: Organize): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('That chat no longer exists.')
    const now = this.now()
    const { pinnedAt, archivedAt, projectId, ...rest } = entry
    const toggle = (on: boolean | undefined, at: number | undefined) =>
      on === undefined ? at : on ? (at ?? now) : undefined
    // Pinning keeps an existing pin's place; only a new pin goes to the end.
    const pin = toggle(change.pinned, pinnedAt)
    const archive = toggle(change.archived, archivedAt)
    const project = change.projectId === undefined ? projectId : (change.projectId ?? undefined)
    const next: ConversationSummary = {
      ...rest,
      ...(pin !== undefined ? { pinnedAt: pin } : {}),
      ...(archive !== undefined ? { archivedAt: archive } : {}),
      ...(project !== undefined ? { projectId: project } : {}),
    }
    await this.change([[id, entry, next]])
  }

  async unfile(projectId: string): Promise<void> {
    const changes: [string, ConversationSummary, ConversationSummary][] = []
    for (const [id, entry] of this.entries) {
      if (entry.projectId !== projectId) continue
      const { projectId: _unfiled, ...next } = entry
      changes.push([id, entry, next])
    }
    if (changes.length > 0) await this.change(changes)
  }

  /**
   * Applies entry changes and writes the index. If the write fails, each entry
   * goes back to how it was unless something else has changed it since.
   */
  private async change(changes: [string, ConversationSummary, ConversationSummary][]) {
    for (const [id, , next] of changes) this.entries.set(id, next)
    try {
      await this.writeIndex()
    } catch (error) {
      for (const [id, before, next] of changes) {
        if (this.entries.get(id) === next) this.entries.set(id, before)
      }
      throw error
    }
  }

  async fork(id: string, prompts: number | null): Promise<string> {
    const source = this.entries.get(id)
    if (!source) throw new Error('That chat no longer exists.')
    const loaded = await createConversationStore(this.file(id)).load()
    if (loaded.error || loaded.messages.length === 0)
      throw new Error('That chat could not be read, so it was not forked.')
    const messages = prompts === null ? loaded.messages : keepPrompts(loaded.messages, prompts)
    // Never a cut that separates a tool call from its result (or leaves nothing).
    if (!messages || messages.length === 0 || !isWellFormed(messages))
      throw new Error('The chat cannot be forked at that point.')
    const forkId = this.newId()
    const file = this.file(forkId)
    if (this.entries.has(forkId)) throw new Error('Could not fork the chat.')
    await createConversationStore(file).save(structuredClone(messages))
    const now = this.now()
    this.entries.set(forkId, {
      id: forkId,
      title: sanitizeTitle(`Fork of ${source.title}`),
      createdAt: now,
      updatedAt: now,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      forkedFrom: {
        id,
        atMessageIndex: messages.length < loaded.messages.length ? messages.length : null,
      },
    })
    try {
      await this.writeIndex()
    } catch (error) {
      this.entries.delete(forkId)
      await removeFile(file).catch(() => {})
      throw error
    }
    return forkId
  }

  /** Writes the index as it is when the write starts; writes never overlap. */
  writeIndex(): Promise<void> {
    const write = this.writes.then(() =>
      writeJsonFile(join(this.dir, 'index.json'), {
        version: 1,
        format: INDEX_FORMAT,
        activeId: this.active,
        conversations: [...this.entries.values()],
      } satisfies IndexFile),
    )
    this.writes = write.catch(() => {})
    return write
  }

  get size(): number {
    return this.entries.size
  }

  setWarning(warning: string): void {
    this.warning ??= warning
  }
}

async function stat(file: string) {
  try {
    return await fs.stat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function times(info: { mtimeMs: number; birthtimeMs: number }) {
  const updatedAt = Math.max(0, Math.round(info.mtimeMs))
  const born = Math.round(info.birthtimeMs)
  return { createdAt: born > 0 && born <= updatedAt ? born : updatedAt, updatedAt }
}

/** Lists the conversation files in `dir`: used only when the index is missing or unreadable. */
async function scan(dir: string): Promise<ConversationSummary[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const found: ConversationSummary[] = []
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
    if (!CONVERSATION_ID.test(id)) continue
    const file = join(dir, name)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) continue
    const loaded = await createConversationStore(file).load()
    found.push({
      id,
      title: loaded.error ? 'Unreadable chat' : titleFrom(loaded.messages),
      ...times(info),
    })
  }
  return found
}

/**
 * Every attachment id that any saved chat under `root` (one folder per
 * connection) still references. Files are read loosely, so a chat this
 * version cannot load still keeps its files; a file that cannot be read at
 * all (other than a missing or corrupt one) throws, so nothing is released
 * on a guess.
 */
export async function referencedAttachmentIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>()
  let providers: string[]
  try {
    providers = await fs.readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ids
    throw error
  }
  for (const provider of providers) {
    const dir = join(root, provider)
    if (!(await stat(dir))?.isDirectory()) continue
    for (const name of await fs.readdir(dir)) {
      if (!CONVERSATION_ID.test(name.slice(0, -'.json'.length)) || !name.endsWith('.json')) continue
      let parsed: unknown
      try {
        parsed = await readJsonFile(join(dir, name))
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
      attachmentIdsIn(parsed, ids)
    }
  }
  return ids
}

type Migration =
  { kind: 'none' } | { kind: 'unreadable' } | { kind: 'migrated'; entry: ConversationSummary }

/**
 * Moves the single saved conversation of earlier versions into the history.
 * The file is moved as is (renamed, so a crash can never leave two copies),
 * and only after it has been read and validated. An unreadable file is left
 * where it is, untouched.
 */
async function migrateLegacy(file: string, dir: string, id: string): Promise<Migration> {
  const info = await stat(file)
  if (!info) return { kind: 'none' }
  const loaded = await createConversationStore(file).load()
  if (loaded.error) return { kind: 'unreadable' }
  if (loaded.messages.length === 0) {
    await removeFile(file)
    return { kind: 'none' }
  }
  const target = join(dir, `${id}.json`)
  await fs.mkdir(dir, { recursive: true })
  try {
    await fs.rename(file, target)
  } catch {
    // Another volume, or the file is held open: copy what was validated, then remove it.
    await createConversationStore(target).save(loaded.messages)
    await removeFile(file).catch(() => {})
  }
  return { kind: 'migrated', entry: { id, title: titleFrom(loaded.messages), ...times(info) } }
}

/**
 * Opens one provider's saved conversations: `dir/index.json` lists them
 * (id, title, times) and each one's messages live in `dir/<id>.json`, the
 * same format the single conversation file had. Only the index is read here;
 * a conversation's messages are read when it is opened.
 *
 * With no index (first run of this version), the old single conversation is
 * moved in and opened. A missing or unreadable index is rebuilt from the
 * conversation files. Problems are reported once, by the first load.
 */
export async function openHistory(
  dir: string,
  options: HistoryOptions = {},
): Promise<ConversationHistory> {
  let raw: unknown
  let unreadable = false
  try {
    raw = await readJsonFile(join(dir, 'index.json'))
  } catch {
    unreadable = true
  }
  const parsed = raw === undefined ? null : indexSchema.safeParse(raw)
  if (!unreadable && parsed?.success) return new FileHistory(dir, parsed.data, null, options)

  let warning: string | null = unreadable || parsed ? MESSAGES.indexRebuilt : null
  const conversations = await scan(dir)
  let activeId = [...conversations].sort(byRecent)[0]?.id ?? null
  let legacyFound = false
  if (options.legacyFile) {
    let migration: Migration
    try {
      migration = await migrateLegacy(options.legacyFile, dir, (options.newId ?? randomUUID)())
    } catch {
      migration = { kind: 'unreadable' }
    }
    legacyFound = migration.kind !== 'none'
    if (migration.kind === 'unreadable') warning ??= MESSAGES.legacyUnreadable
    if (migration.kind === 'migrated') {
      conversations.push(migration.entry)
      activeId = migration.entry.id
    }
  }
  const history = new FileHistory(dir, { activeId, conversations }, warning, options)
  // Nothing to remember for a provider that was never used: leave its folder unmade.
  if (history.size > 0 || legacyFound || warning) {
    try {
      await history.writeIndex()
    } catch {
      history.setWarning(MESSAGES.indexUnsaved)
    }
  }
  return history
}
