import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isWellFormed } from './conversation-store'
import { CONVERSATION_ID, INDEX_FORMAT, keepPrompts, MESSAGES, openHistory } from './history-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-organize-'))
  directories.push(path)
  return path
}

const ID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ID_B = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'
const ID_F = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a'
const PROJECT = '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b'

const fileText = (messages: MessageParam[]) => JSON.stringify({ version: 1, messages })
const conversation = (text: string): MessageParam[] => [
  { role: 'user', content: text },
  { role: 'assistant', content: [{ type: 'text', text: `About ${text}` }] },
]
/** Two prompts; the first one's reply calls a tool. */
const withTools: MessageParam[] = [
  { role: 'user', content: 'List the folder' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_dir', input: { path: '.' } }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'One file.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Open it' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
]

const v1Index = (conversations: object[], activeId: string | null = null) =>
  JSON.stringify({ version: 1, activeId, conversations })

/** The index parser of the previous build (main before format 2), verbatim. */
const previousBuildSchema = z.object({
  version: z.literal(1),
  activeId: z.string().regex(CONVERSATION_ID).nullable(),
  conversations: z.array(
    z.object({
      id: z.string().regex(CONVERSATION_ID),
      title: z.string(),
      createdAt: z.number().nonnegative(),
      updatedAt: z.number().nonnegative(),
    }),
  ),
})

async function twoChats(dir: string) {
  await writeFile(join(dir, `${ID_A}.json`), fileText(conversation('alpha')))
  await writeFile(join(dir, `${ID_B}.json`), fileText(withTools))
  await writeFile(
    join(dir, 'index.json'),
    v1Index([
      { id: ID_A, title: 'Renamed alpha', createdAt: 1, updatedAt: 1 },
      { id: ID_B, title: 'Tools', createdAt: 2, updatedAt: 2 },
    ]),
  )
}

describe('index format 2', () => {
  it('reads a format-1 index with nothing pinned, archived, filed or forked', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir)
    expect(history.state().conversations).toEqual([
      { id: ID_B, title: 'Tools', createdAt: 2, updatedAt: 2 },
      { id: ID_A, title: 'Renamed alpha', createdAt: 1, updatedAt: 1 },
    ])
    // Read only: nothing is rewritten until something changes.
    expect(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))).not.toHaveProperty('format')
  })

  it('upgrades on the next change and keeps the new fields across a restart', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir, { now: () => 50 })
    await history.organize(ID_A, { pinned: true, projectId: PROJECT })
    await history.organize(ID_B, { archived: true })
    const raw = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as {
      version: number
      format: number
    }
    expect([raw.version, raw.format]).toEqual([1, INDEX_FORMAT])
    const reopened = await openHistory(dir)
    const byId = new Map(reopened.state().conversations.map((c) => [c.id, c]))
    expect(byId.get(ID_A)).toMatchObject({
      pinnedAt: 50,
      projectId: PROJECT,
      title: 'Renamed alpha',
    })
    expect(byId.get(ID_B)).toMatchObject({ archivedAt: 50 })
    expect(byId.get(ID_B)).not.toHaveProperty('pinnedAt')
  })

  it('stays readable by the previous build, with every chat and title', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir, { newId: () => ID_F })
    await history.organize(ID_A, { pinned: true, archived: true, projectId: PROJECT })
    await history.fork(ID_B, 1)
    const parsed = previousBuildSchema.safeParse(
      JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')),
    )
    expect(parsed.success).toBe(true)
    expect(parsed.data?.conversations.map((c) => [c.id, c.title]).sort()).toEqual(
      [
        [ID_A, 'Renamed alpha'],
        [ID_B, 'Tools'],
        [ID_F, 'Fork of Tools'],
      ].sort(),
    )
  })

  it('reads an invalid new field as unset, keeping the chat', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, `${ID_A}.json`), fileText(conversation('alpha')))
    await writeFile(
      join(dir, 'index.json'),
      v1Index([
        {
          id: ID_A,
          title: 'alpha',
          createdAt: 1,
          updatedAt: 1,
          pinnedAt: 'soon',
          archivedAt: -4,
          projectId: '../../settings',
          forkedFrom: { id: 'C:\\x' },
          unknown: { nested: true },
        },
      ]),
    )
    const history = await openHistory(dir)
    expect(history.state().conversations).toEqual([
      { id: ID_A, title: 'alpha', createdAt: 1, updatedAt: 1 },
    ])
    expect((await history.current().load()).error).toBeNull()
  })

  it('serialises concurrent changes: every one is kept, in order', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    let time = 100
    const history = await openHistory(dir, { now: () => (time += 1), newId: () => ID_F })
    await Promise.all([
      history.organize(ID_A, { pinned: true }),
      history.organize(ID_A, { projectId: PROJECT }),
      history.organize(ID_B, { archived: true }),
      history.rename(ID_B, 'Tools, renamed'),
      history.open(ID_A).save([...conversation('alpha'), ...conversation('again')]),
      history.organize(ID_A, { archived: true }),
      history.organize(ID_A, { archived: false }),
      history.fork(ID_A, null),
    ])
    const reopened = await openHistory(dir)
    const byId = new Map(reopened.state().conversations.map((c) => [c.id, c]))
    expect(byId.get(ID_A)).toMatchObject({ pinnedAt: 101, projectId: PROJECT })
    expect(byId.get(ID_A)).not.toHaveProperty('archivedAt')
    expect(byId.get(ID_B)?.title).toBe('Tools, renamed')
    expect(byId.get(ID_B)?.archivedAt).toBeGreaterThan(100)
    expect(byId.get(ID_F)).toMatchObject({ title: 'Fork of Renamed alpha', projectId: PROJECT })
  })

  it('keeps a pin in place when pinned again, and unsets cleanly', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    let time = 10
    const history = await openHistory(dir, { now: () => (time += 1) })
    await history.organize(ID_A, { pinned: true })
    await history.organize(ID_A, { pinned: true })
    expect(history.state().conversations.find((c) => c.id === ID_A)?.pinnedAt).toBe(11)
    await history.organize(ID_A, { pinned: false, projectId: PROJECT })
    await history.organize(ID_A, { projectId: null })
    expect(history.state().conversations.find((c) => c.id === ID_A)).toEqual({
      id: ID_A,
      title: 'Renamed alpha',
      createdAt: 1,
      updatedAt: 1,
    })
  })

  it('takes every chat out of a deleted project', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir)
    await history.organize(ID_A, { projectId: PROJECT, pinned: true })
    await history.organize(ID_B, { projectId: PROJECT })
    await history.unfile(PROJECT)
    const chats = (await openHistory(dir)).state().conversations
    expect(chats.every((c) => c.projectId === undefined)).toBe(true)
    expect(chats.find((c) => c.id === ID_A)?.pinnedAt).toBeDefined()
  })

  it('puts a change back when the index cannot be written', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir)
    await history.organize(ID_A, { pinned: true })
    // A folder where the index goes: the atomic rename onto it fails.
    await rm(join(dir, 'index.json'))
    await mkdir(join(dir, 'index.json', 'blocker'), { recursive: true })
    await expect(history.organize(ID_B, { archived: true })).rejects.toThrow()
    expect(history.state().conversations.find((c) => c.id === ID_B)).not.toHaveProperty(
      'archivedAt',
    )
    expect(history.state().conversations.find((c) => c.id === ID_A)?.pinnedAt).toBeDefined()
  })

  it('a damaged index is rebuilt from the chat files, losing only the new fields and names', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir)
    await history.organize(ID_A, { pinned: true, projectId: PROJECT })
    await writeFile(join(dir, 'index.json'), '{ broken')
    const rebuilt = await openHistory(dir)
    expect(
      rebuilt
        .state()
        .conversations.map((c) => c.id)
        .sort(),
    ).toEqual([ID_A, ID_B].sort())
    expect(rebuilt.state().conversations.every((c) => c.pinnedAt === undefined)).toBe(true)
    expect((await rebuilt.current().load()).error).toContain(MESSAGES.indexRebuilt)
  })

  it('refuses ids it did not make, before any path is built', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir)
    for (const id of ['../index', 'C:\\Windows\\x', `${ID_A}/../x`, '']) {
      await expect(history.organize(id, { pinned: true })).rejects.toThrow(
        'That chat no longer exists.',
      )
      await expect(history.fork(id, null)).rejects.toThrow('That chat no longer exists.')
    }
    expect((await readdir(dir)).sort()).toEqual([`${ID_A}.json`, `${ID_B}.json`, 'index.json'])
  })
})

describe('fork', () => {
  it('copies the whole chat into a new one, leaving the source as it was', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir, { newId: () => ID_F, now: () => 99 })
    await history.organize(ID_B, { projectId: PROJECT, pinned: true, archived: true })
    const before = await readFile(join(dir, `${ID_B}.json`), 'utf8')
    expect(await history.fork(ID_B, null)).toBe(ID_F)
    expect(await readFile(join(dir, `${ID_B}.json`), 'utf8')).toBe(before)
    expect((await history.open(ID_F).load()).messages).toEqual(withTools)
    // Filed with its source, but not pinned or archived like it.
    expect(history.state().conversations.find((c) => c.id === ID_F)).toEqual({
      id: ID_F,
      title: 'Fork of Tools',
      createdAt: 99,
      updatedAt: 99,
      projectId: PROJECT,
      forkedFrom: { id: ID_B, atMessageIndex: null },
    })
  })

  it('forks from a prompt: keeps that many prompts with their whole replies', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir, { newId: () => ID_F })
    await history.fork(ID_B, 1)
    const { messages } = await history.open(ID_F).load()
    expect(messages).toEqual(withTools.slice(0, 4))
    expect(history.state().conversations.find((c) => c.id === ID_F)?.forkedFrom).toEqual({
      id: ID_B,
      atMessageIndex: 4,
    })
  })

  it('refuses a fork point past the end, and an unreadable chat', async () => {
    const dir = await tempDir()
    await twoChats(dir)
    const history = await openHistory(dir, { newId: () => ID_F })
    await expect(history.fork(ID_B, 3)).rejects.toThrow('cannot be forked at that point')
    await writeFile(join(dir, `${ID_A}.json`), '{ broken')
    await expect(history.fork(ID_A, null)).rejects.toThrow('could not be read')
    expect(history.has(ID_F)).toBe(false)
  })

  it('never cuts between a tool call and its result', () => {
    // Tool results going back to the model are not prompts, so no cut lands on one.
    for (let prompts = 1; prompts <= 2; prompts += 1) {
      const kept = keepPrompts(withTools, prompts)
      expect(kept).not.toBeNull()
      expect(isWellFormed(kept ?? [])).toBe(true)
    }
    expect(keepPrompts(withTools, 1)).toHaveLength(4)
    expect(keepPrompts(withTools, 2)).toHaveLength(6)
    expect(keepPrompts(withTools, 3)).toBeNull()
  })
})
