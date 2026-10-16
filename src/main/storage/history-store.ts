import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'
import type { ConversationSummary, HistoryState } from '../../shared/ipc'
import { createConversationStore, type ConversationStore } from './conversation-store'
import { readJsonFile, removeFile, writeJsonFile } from './json-file'

/**
 * Conversation ids are random v4 UUIDs, made in main. A file path is only
 * ever built from an id that matches this, never from anything else.
 */
export const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Titles made from the first message are cut to this many characters. */
export const TITLE_LENGTH = 60
/** The longest title a rename keeps. */
export const MAX_TITLE_LENGTH = 100

export const MESSAGES = {
  legacyUnreadable: 'The saved conversation could not be read, so a new one was started.',
  missing: 'The saved conversation could not be found, so a new one was started.',
  indexRebuilt: 'The chat history list could not be read, so it was rebuilt from the saved chats.',
  indexUnsaved: 'The chat history could not be saved to disk.',
} as const

// Controls, format characters (bidi overrides and isolates, zero-width), lone
// surrogates, private use, and line/paragraph separators: none belong in a title.
const UNSAFE_TITLE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu

/** One line of plain text: unsafe characters become spaces, runs of space collapse. */
export function sanitizeTitle(text: string, max = MAX_TITLE_LENGTH): string {
  const clean = text.replace(UNSAFE_TITLE_CHARS, ' ').replace(/\s+/gu, ' ').trim()
  const chars = Array.from(clean)
  return chars.length <= max
    ? clean
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
}

/** The first thing the user typed, as a title. */
export function titleFrom(messages: readonly MessageParam[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')
    const title = sanitizeTitle(text, TITLE_LENGTH)
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
}

const idSchema = z.string().regex(CONVERSATION_ID)
const timeSchema = z.number().nonnegative()
const indexSchema = z.object({
  version: z.literal(1),
  activeId: idSchema.nullable(),
  conversations: z.array(
    z.object({ id: idSchema, title: z.string(), createdAt: timeSchema, updatedAt: timeSchema }),
  ),
})
type IndexFile = z.infer<typeof indexSchema>

export interface HistoryOptions {
  /** The single conversation file of earlier versions, moved into the history once. */
  legacyFile?: string
  newId?: () => string
  now?: () => number
  /** Index writes that fail where nobody is waiting for them (setActive). */
  onError?: (error: unknown) => void
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
        ...entry,
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
    await removeFile(this.file(id))
  }

  /** Writes the index as it is when the write starts; writes never overlap. */
  writeIndex(): Promise<void> {
    const write = this.writes.then(() =>
      writeJsonFile(join(this.dir, 'index.json'), {
        version: 1,
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
