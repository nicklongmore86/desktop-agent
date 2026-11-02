import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toTranscript } from '../chat/transcript'
import {
  createConversationStore,
  parseOrigin,
  withOrigin,
  type MessageOrigin,
  type StoredMessage,
} from './conversation-store'
import { CONVERSATION_ID, INDEX_FORMAT, openHistory } from './history-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-unified-'))
  directories.push(path)
  return path
}

const ID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ID_F = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a'

/** Two prompts, each answered: the first on Gemini, the second on Claude API. */
const chat: StoredMessage[] = [
  { role: 'user', content: 'one' },
  { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] },
  { role: 'user', content: 'two' },
  { role: 'assistant', content: [{ type: 'text', text: 'second reply' }] },
]
const origin: MessageOrigin[] = [
  { fromIndex: 1, connection: 'gemini-api', model: 'gemini-3-pro' },
  { fromIndex: 3, connection: 'anthropic-api', model: 'claude-opus-5-5' },
]

/** The previous build's index parser (main before format 3), verbatim. */
const lenient = <T extends z.ZodType>(schema: T) => schema.nullable().optional().catch(null)
const previousIdSchema = z.string().regex(CONVERSATION_ID)
const previousBuildSchema = z.object({
  version: z.literal(1),
  format: z.number().optional(),
  activeId: previousIdSchema.nullable(),
  conversations: z.array(
    z.object({
      id: previousIdSchema,
      title: z.string(),
      createdAt: z.number().nonnegative(),
      updatedAt: z.number().nonnegative(),
      pinnedAt: lenient(z.number().nonnegative()),
      archivedAt: lenient(z.number().nonnegative()),
      projectId: lenient(previousIdSchema),
      forkedFrom: lenient(
        z.object({ id: previousIdSchema, atMessageIndex: z.number().int().positive().nullable() }),
      ),
    }),
  ),
})

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>

describe('index format 3: lastConnection', () => {
  it('records the latest reply’s connection on save, keeping version 1 on disk', async () => {
    const dir = await tempDir()
    const history = await openHistory(dir, { newId: () => ID_A, now: () => 5 })
    await history.draft().save(chat, origin)
    expect(history.state().conversations[0]).toMatchObject({
      id: ID_A,
      lastConnection: 'anthropic-api',
    })
    const raw = await readJson(join(dir, 'index.json'))
    expect([raw['version'], raw['format']]).toEqual([1, INDEX_FORMAT])
    expect(INDEX_FORMAT).toBe(3)
    const reopened = await openHistory(dir)
    expect(reopened.state().conversations[0]?.lastConnection).toBe('anthropic-api')
  })

  it('stays readable by the previous build, which drops only the new field', async () => {
    const dir = await tempDir()
    const history = await openHistory(dir, { newId: () => ID_A })
    await history.draft().save(chat, origin)
    await history.organize(ID_A, { pinned: true })
    const parsed = previousBuildSchema.safeParse(await readJson(join(dir, 'index.json')))
    expect(parsed.success).toBe(true)
    expect(parsed.data?.conversations).toEqual([
      expect.objectContaining({ id: ID_A, title: 'one', pinnedAt: expect.any(Number) as number }),
    ])
    expect(parsed.data?.conversations[0]).not.toHaveProperty('lastConnection')
  })

  it('reads a format-2 index and an invalid lastConnection as unset, keeping the chat', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, `${ID_A}.json`), JSON.stringify({ version: 1, messages: chat }))
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({
        version: 1,
        format: 2,
        activeId: ID_A,
        conversations: [
          { id: ID_A, title: 'Old', createdAt: 1, updatedAt: 2, lastConnection: '../evil' },
        ],
      }),
    )
    const history = await openHistory(dir)
    expect(history.state()).toEqual({
      conversations: [{ id: ID_A, title: 'Old', createdAt: 1, updatedAt: 2 }],
      activeId: ID_A,
    })
    // An old chat file (no origin) loads as before, with no provenance.
    const loaded = await history.open(ID_A).load()
    expect(loaded).toEqual({ messages: chat, error: null })
    expect(toTranscript(loaded.messages, new Set(), loaded.origin)).toEqual([
      { kind: 'user', id: 'h0.0', text: 'one' },
      { kind: 'assistant', id: 'h1.0', text: 'first reply' },
      { kind: 'user', id: 'h2.0', text: 'two' },
      { kind: 'assistant', id: 'h3.0', text: 'second reply' },
    ])
  })
})

describe('chat file origin', () => {
  it('is saved at the top level, never on a message, and read back', async () => {
    const dir = await tempDir()
    const file = join(dir, 'chat.json')
    await createConversationStore(file).save(chat, origin)
    const raw = await readJson(file)
    expect(Object.keys(raw).sort()).toEqual(['messages', 'origin', 'version'])
    // Older builds send messages to the APIs as they are: they must be exactly what was given.
    expect(raw['messages']).toEqual(chat)
    for (const message of raw['messages'] as object[])
      expect(Object.keys(message).sort()).toEqual(['content', 'role'])
    expect(await createConversationStore(file).load()).toEqual({
      messages: chat,
      error: null,
      origin,
    })
    // Without provenance nothing is added: the file is the old shape exactly.
    await createConversationStore(file).save(chat)
    expect(Object.keys(await readJson(file)).sort()).toEqual(['messages', 'version'])
  })

  it('an older build saving the chat drops only the provenance', async () => {
    const dir = await tempDir()
    const history = await openHistory(dir, { newId: () => ID_A })
    await history.draft().save(chat, origin)
    // What an older build writes back: version and messages, nothing else.
    const raw = await readJson(join(dir, `${ID_A}.json`))
    await writeFile(
      join(dir, `${ID_A}.json`),
      JSON.stringify({ version: raw['version'], messages: raw['messages'] }),
    )
    const loaded = await history.open(ID_A).load()
    expect(loaded).toEqual({ messages: chat, error: null })
  })

  it('reads malformed provenance as none, never as an unreadable chat', async () => {
    const bad: unknown[] = [
      'x',
      [
        { fromIndex: 1, connection: 'gemini-api' },
        { fromIndex: 1, connection: 'openai-api' },
      ],
      [{ fromIndex: 9, connection: 'gemini-api', model: null }],
      [{ fromIndex: -1, connection: 'gemini-api', model: null }],
      [{ fromIndex: 1, connection: '../../x', model: null }],
      [{ fromIndex: 1, connection: 'gemini-api', model: 'has space' }],
      [null],
    ]
    for (const value of bad) expect(parseOrigin(value, chat.length)).toEqual([])
    expect(
      parseOrigin([{ fromIndex: 1, connection: 'future-connection', extra: true }], chat.length),
    ).toEqual([{ fromIndex: 1, connection: 'future-connection', model: null }])

    const dir = await tempDir()
    const file = join(dir, 'chat.json')
    await writeFile(file, JSON.stringify({ version: 1, messages: chat, origin: bad[1] }))
    expect(await createConversationStore(file).load()).toEqual({ messages: chat, error: null })
  })

  it('adds an entry only where the writer changes', () => {
    const one = withOrigin([], 1, 'gemini-api', 'm')
    expect(withOrigin(one, 3, 'gemini-api', 'm')).toEqual(one)
    expect(withOrigin(one, 3, 'gemini-api', 'n')).toEqual([
      ...one,
      { fromIndex: 3, connection: 'gemini-api', model: 'n' },
    ])
    // A rewrite from an earlier index replaces what came after it.
    expect(withOrigin(origin, 3, 'openai-api', null)).toEqual([
      origin[0],
      { fromIndex: 3, connection: 'openai-api', model: null },
    ])
  })

  it('marks each assistant reply with the connection and model that wrote it', () => {
    const items = toTranscript(chat, new Set(), origin)
    expect(items.filter((item) => item.kind === 'assistant')).toEqual([
      {
        kind: 'assistant',
        id: 'h1.0',
        text: 'first reply',
        connection: 'gemini-api',
        model: 'gemini-3-pro',
      },
      {
        kind: 'assistant',
        id: 'h3.0',
        text: 'second reply',
        connection: 'anthropic-api',
        model: 'claude-opus-5-5',
      },
    ])
    // A reply before the first entry has no provenance; a null model is left out.
    expect(
      toTranscript(chat, new Set(), [{ fromIndex: 3, connection: 'ollama', model: null }]).filter(
        (item) => item.kind === 'assistant',
      ),
    ).toEqual([
      { kind: 'assistant', id: 'h1.0', text: 'first reply' },
      { kind: 'assistant', id: 'h3.0', text: 'second reply', connection: 'ollama' },
    ])
  })
})

describe('fork with provenance', () => {
  it('copies the whole origin with the whole chat', async () => {
    const dir = await tempDir()
    const ids = [ID_A, ID_F]
    const history = await openHistory(dir, { newId: () => ids.shift() ?? 'none' })
    await history.draft().save(chat, origin)
    const fork = await history.fork(ID_A, null)
    expect(await history.open(fork).load()).toEqual({ messages: chat, error: null, origin })
    expect(history.state().conversations.find((c) => c.id === fork)?.lastConnection).toBe(
      'anthropic-api',
    )
  })

  it('trims the origin at the cut, and the fork’s lastConnection with it', async () => {
    const dir = await tempDir()
    const ids = [ID_A, ID_F]
    const history = await openHistory(dir, { newId: () => ids.shift() ?? 'none' })
    await history.draft().save(chat, origin)
    const fork = await history.fork(ID_A, 1)
    const loaded = await history.open(fork).load()
    expect(loaded).toEqual({ messages: chat.slice(0, 2), error: null, origin: [origin[0]] })
    expect(await readJson(join(dir, `${fork}.json`))).toEqual({
      version: 1,
      messages: chat.slice(0, 2),
      origin: [origin[0]],
    })
    expect(history.state().conversations.find((c) => c.id === fork)).toMatchObject({
      lastConnection: 'gemini-api',
      forkedFrom: { id: ID_A, atMessageIndex: 2 },
    })
  })
})
