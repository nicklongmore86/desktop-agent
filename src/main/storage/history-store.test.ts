import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { afterEach, describe, expect, it } from 'vitest'
import { MESSAGES, openHistory, sanitizeTitle, titleFrom, TITLE_LENGTH } from './history-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-history-'))
  directories.push(path)
  return path
}

const ID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ID_B = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'
const ID_C = '2c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f'

function ids(...list: string[]) {
  const queue = [...list]
  return () => {
    const id = queue.shift()
    if (!id) throw new Error('out of ids')
    return id
  }
}

const conversation = (text: string): MessageParam[] => [
  { role: 'user', content: text },
  { role: 'assistant', content: [{ type: 'text', text: `About ${text}` }] },
]
const fileText = (messages: MessageParam[]) => JSON.stringify({ version: 1, messages })

describe('titles', () => {
  it('keeps one line of plain text and cuts it at the limit', () => {
    expect(sanitizeTitle('  Fix\nthe\t\tbuild  ')).toBe('Fix the build')
    // Bidi overrides and isolates, zero-width and other format characters, C0/C1 controls.
    expect(sanitizeTitle('evil\u202Etxt.exe\u2066x\u2069\u200B\u0007\u009B end')).toBe(
      'evil txt.exe x end',
    )
    expect(sanitizeTitle('a\u2028b\u2029c')).toBe('a b c')
    expect(sanitizeTitle('\u202E\u200F ')).toBe('')
    const long = sanitizeTitle('x'.repeat(200), 60)
    expect(Array.from(long)).toHaveLength(60)
    expect(long.endsWith('…')).toBe(true)
    // Never splits a surrogate pair.
    const emoji = sanitizeTitle('😀'.repeat(80), 60)
    expect(emoji).toBe(`${'😀'.repeat(59)}…`)
  })

  it('titles a chat by its first user text', () => {
    expect(titleFrom(conversation('Plan the release'))).toBe('Plan the release')
    expect(
      titleFrom([
        { role: 'user', content: [{ type: 'text', text: ' \u202E ' }] },
        { role: 'user', content: [{ type: 'text', text: 'Second try' }] },
      ]),
    ).toBe('Second try')
    expect(Array.from(titleFrom(conversation('y'.repeat(500))))).toHaveLength(TITLE_LENGTH)
    expect(titleFrom([])).toBe('New chat')
  })
})

describe('history store', () => {
  it('starts empty without writing anything for an unused provider', async () => {
    const dir = join(await tempDir(), 'history', 'p')
    const history = await openHistory(dir, { legacyFile: join(dir, '..', 'none.json') })
    expect(history.state()).toEqual({ conversations: [], activeId: null })
    expect(await history.current().load()).toEqual({ messages: [], error: null })
    await expect(readdir(dir)).rejects.toThrow()
  })

  it('saves a draft on its first save, lists it newest first and reopens it', async () => {
    const dir = await tempDir()
    let now = 1000
    const options = { newId: ids(ID_A, ID_B), now: () => now }
    const history = await openHistory(dir, options)
    const first = history.draft()
    await first.save(conversation('First question'))
    expect(history.activeId).toBe(ID_A)
    now = 2000
    const second = history.draft()
    await history.setActive(null)
    await second.save(conversation('Second question'))
    now = 3000
    await first.save([...conversation('First question'), { role: 'user', content: 'More' }])

    expect(history.state()).toEqual({
      activeId: ID_B,
      conversations: [
        { id: ID_A, title: 'First question', createdAt: 1000, updatedAt: 3000 },
        { id: ID_B, title: 'Second question', createdAt: 2000, updatedAt: 2000 },
      ],
    })
    expect((await readdir(dir)).sort()).toEqual([`${ID_A}.json`, `${ID_B}.json`, 'index.json'])

    const reopened = await openHistory(dir)
    expect(reopened.state()).toEqual(history.state())
    expect(await reopened.current().load()).toEqual({
      messages: conversation('Second question'),
      error: null,
    })
    expect((await reopened.open(ID_A).load()).messages).toHaveLength(3)
  })

  it('reads only the index when opening, and reports a broken or missing chat when it is opened', async () => {
    const dir = await tempDir()
    const history = await openHistory(dir, { newId: ids(ID_A, ID_B) })
    await history.draft().save(conversation('one'))
    await history.draft().save(conversation('two'))
    await writeFile(join(dir, `${ID_A}.json`), '{ not json')
    await rm(join(dir, `${ID_B}.json`))

    const reopened = await openHistory(dir)
    expect(
      reopened
        .state()
        .conversations.map((c) => c.id)
        .sort(),
    ).toEqual([ID_A, ID_B].sort())
    expect(await reopened.open(ID_A).load()).toEqual({
      messages: [],
      error: MESSAGES.legacyUnreadable,
    })
    expect(await reopened.open(ID_B).load()).toEqual({ messages: [], error: MESSAGES.missing })
  })

  it('renames with the same plain-text rules and refuses empty names and unknown chats', async () => {
    const dir = await tempDir()
    const history = await openHistory(dir, { newId: ids(ID_A) })
    await history.draft().save(conversation('one'))
    await history.rename(ID_A, '  Release\u202E plan\n')
    expect(history.state().conversations[0]?.title).toBe('Release plan')
    await expect(history.rename(ID_A, '\u200B \u202E')).rejects.toThrow('Enter a name')
    await expect(history.rename(ID_B, 'x')).rejects.toThrow('no longer exists')
    expect((await openHistory(dir)).state().conversations[0]?.title).toBe('Release plan')
  })

  it('deletes a chat and its file, and forgets it was open', async () => {
    const dir = await tempDir()
    const history = await openHistory(dir, { newId: ids(ID_A, ID_B) })
    await history.draft().save(conversation('keep'))
    await history.setActive(null)
    await history.draft().save(conversation('drop'))
    expect(history.activeId).toBe(ID_B)
    await history.remove(ID_B)
    await history.remove(ID_B)
    expect(history.state()).toEqual({
      activeId: null,
      conversations: [expect.objectContaining({ id: ID_A }) as unknown],
    })
    expect((await readdir(dir)).sort()).toEqual([`${ID_A}.json`, 'index.json'])
  })

  it('never builds a path from an id it did not make', async () => {
    const dir = await tempDir()
    const history = await openHistory(dir)
    for (const id of ['../settings', '..\\settings', 'index', ID_A.toUpperCase(), '']) {
      expect(history.has(id)).toBe(false)
      expect(() => history.open(id)).toThrow()
    }
  })

  it('rejects a save when the index cannot be written, keeping the messages on disk', async () => {
    const dir = await tempDir()
    // A folder where the index file should be: the atomic rename over it fails everywhere.
    await mkdir(join(dir, 'index.json', 'blocker'), { recursive: true })
    const history = await openHistory(dir, { newId: ids(ID_A) })
    await expect(history.draft().save(conversation('one'))).rejects.toThrow()
    expect(JSON.parse(await readFile(join(dir, `${ID_A}.json`), 'utf8'))).toEqual({
      version: 1,
      messages: conversation('one'),
    })
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('migration from the single saved conversation', () => {
  async function legacySetup(text: string) {
    const userData = await tempDir()
    const legacyFile = join(userData, 'conversation.json')
    await writeFile(legacyFile, text)
    // Seconds since the epoch: some file systems keep no finer times.
    const mtime = new Date(1_700_000_000_000)
    await utimes(legacyFile, mtime, mtime)
    return { userData, legacyFile, dir: join(userData, 'history', 'anthropic-api') }
  }

  it('moves a valid conversation in unchanged and opens it, once', async () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Read it\nplease' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'C:\\x' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: 'Done.' },
    ]
    const text = `${fileText(messages)}\n`
    const { legacyFile, dir } = await legacySetup(text)
    const history = await openHistory(dir, { legacyFile, newId: ids(ID_A) })
    expect(history.state()).toEqual({
      activeId: ID_A,
      conversations: [
        {
          id: ID_A,
          title: 'Read it please',
          createdAt: expect.any(Number) as unknown,
          updatedAt: 1_700_000_000_000,
        },
      ],
    })
    const [entry] = history.state().conversations
    expect(entry?.createdAt).toBeLessThanOrEqual(1_700_000_000_000)
    // Byte for byte: the file was moved, not rewritten.
    expect(await readFile(join(dir, `${ID_A}.json`), 'utf8')).toBe(text)
    await expect(readFile(legacyFile)).rejects.toThrow()
    expect(await history.current().load()).toEqual({ messages, error: null })

    // A second start reads the index and migrates nothing.
    await writeFile(legacyFile, fileText(conversation('stray')))
    const again = await openHistory(dir, { legacyFile, newId: ids(ID_B) })
    expect(again.state().conversations.map((c) => c.id)).toEqual([ID_A])
  })

  it.each([
    ['not json', '{'],
    ['the wrong shape', '{"version":1,"messages":[{"role":"system","content":"x"}]}'],
    ['a truncated file', fileText(conversation('cut off')).slice(0, 30)],
    ['a newer version', '{"version":2,"messages":[]}'],
  ])('leaves %s where it is, warns once and starts fresh', async (_name, text) => {
    const { legacyFile, dir } = await legacySetup(text)
    const history = await openHistory(dir, { legacyFile })
    expect(history.state()).toEqual({ conversations: [], activeId: null })
    expect(await history.current().load()).toEqual({
      messages: [],
      error: MESSAGES.legacyUnreadable,
    })
    // The warning is shown once.
    expect((await history.current().load()).error).toBeNull()
    expect(await readFile(legacyFile, 'utf8')).toBe(text)
    // The index now exists, so the next start does not warn again.
    const again = await openHistory(dir, { legacyFile })
    expect((await again.current().load()).error).toBeNull()
  })

  it('drops an empty saved conversation', async () => {
    const { legacyFile, dir } = await legacySetup(fileText([]))
    const history = await openHistory(dir, { legacyFile })
    expect(history.state().conversations).toEqual([])
    await expect(readFile(legacyFile)).rejects.toThrow()
  })

  it('finds a conversation moved in just before a crash (no index yet)', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, `${ID_A}.json`), fileText(conversation('moved')))
    const history = await openHistory(dir, { legacyFile: join(dir, 'gone.json') })
    expect(history.state()).toEqual({
      activeId: ID_A,
      conversations: [expect.objectContaining({ id: ID_A, title: 'moved' }) as unknown],
    })
    expect(await history.current().load()).toEqual({
      messages: conversation('moved'),
      error: null,
    })
  })
})

describe('a damaged index', () => {
  it.each([
    ['not json', '{'],
    ['an unknown version', JSON.stringify({ version: 9, activeId: null, conversations: [] })],
    [
      'a path for an id',
      JSON.stringify({
        version: 1,
        activeId: null,
        conversations: [{ id: '../../settings', title: 'x', createdAt: 0, updatedAt: 0 }],
      }),
    ],
  ])('is rebuilt from the chat files when it is %s', async (_name, text) => {
    const dir = await tempDir()
    await writeFile(join(dir, `${ID_A}.json`), fileText(conversation('alpha')))
    await writeFile(join(dir, `${ID_B}.json`), '{ broken')
    await writeFile(join(dir, 'notes.json'), fileText(conversation('ignored')))
    await writeFile(join(dir, 'index.json'), text)
    const history = await openHistory(dir)
    const titles = Object.fromEntries(history.state().conversations.map((c) => [c.id, c.title]))
    expect(titles).toEqual({ [ID_A]: 'alpha', [ID_B]: 'Unreadable chat' })
    expect((await history.current().load()).error).toContain(MESSAGES.indexRebuilt)
    // Rewritten, so the next start reads it normally.
    expect((await (await openHistory(dir)).current().load()).error ?? '').not.toContain(
      MESSAGES.indexRebuilt,
    )
  })

  it('keeps titles plain text and drops duplicate or unknown entries', async () => {
    const dir = await tempDir()
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({
        version: 1,
        activeId: ID_C,
        conversations: [
          { id: ID_A, title: '<b>x</b>\u202Egnp.exe\u0000', createdAt: 1, updatedAt: 2 },
          { id: ID_A, title: 'duplicate', createdAt: 1, updatedAt: 9 },
          { id: ID_B, title: '\u200B', createdAt: 1, updatedAt: 1 },
        ],
      }),
    )
    const history = await openHistory(dir)
    expect(history.state()).toEqual({
      // The open chat is not listed, so a new chat is open instead.
      activeId: null,
      conversations: [
        { id: ID_A, title: '<b>x</b> gnp.exe', createdAt: 1, updatedAt: 2 },
        { id: ID_B, title: 'Untitled chat', createdAt: 1, updatedAt: 1 },
      ],
    })
  })
})
