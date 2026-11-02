import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConversationStore, parseSharing, type StoredMessage } from './conversation-store'
import { openHistory } from './history-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-sharing-store-'))
  directories.push(path)
  return path
}

const chat: StoredMessage[] = [
  { role: 'user', content: 'one' },
  { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
  { role: 'user', content: 'two' },
  { role: 'assistant', content: [{ type: 'text', text: 'reply two' }] },
]

describe('the chat file’s sharing confirmations', () => {
  it('are saved at the top level and read back', async () => {
    const file = join(await tempDir(), 'chat.json')
    const store = createConversationStore(file)
    await store.save(chat, [], [{ connection: 'openai-api', through: 4 }])
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['messages', 'sharing', 'version'])
    expect(raw['messages']).toEqual(chat)
    expect((await store.load()).sharing).toEqual([{ connection: 'openai-api', through: 4 }])
  })

  it('a file without them (an older build’s) loads with none', async () => {
    const file = join(await tempDir(), 'chat.json')
    await writeFile(file, JSON.stringify({ version: 1, messages: chat }))
    const loaded = await createConversationStore(file).load()
    expect(loaded.error).toBeNull()
    expect(loaded.sharing).toBeUndefined()
  })

  it('malformed ones read as none, never as an unreadable chat', async () => {
    const file = join(await tempDir(), 'chat.json')
    for (const sharing of [
      'yes',
      [{ connection: '../x', through: 1 }],
      [{ connection: 'openai-api', through: -1 }],
      [{ connection: 'openai-api', through: 1.5 }],
      [{ connection: 'openai-api' }],
      [
        { connection: 'openai-api', through: 1 },
        { connection: 'openai-api', through: 2 },
      ],
    ]) {
      await writeFile(file, JSON.stringify({ version: 1, messages: chat, sharing }))
      const loaded = await createConversationStore(file).load()
      expect(loaded.error).toBeNull()
      expect(loaded.messages).toEqual(chat)
      expect(loaded.sharing).toBeUndefined()
    }
  })

  it('never covers more messages than the chat has', () => {
    expect(parseSharing([{ connection: 'openai-api', through: 99 }], 4)).toEqual([
      { connection: 'openai-api', through: 4 },
    ])
  })

  it('a fork does not copy them: it asks again', async () => {
    const dir = await tempDir()
    let n = 0
    const ids = ['0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a']
    const history = await openHistory(dir, { newId: () => ids[n++] ?? 'x' })
    await history.draft().save(chat, [], [{ connection: 'openai-api', through: 4 }])
    const fork = await history.fork(ids[0] as string, null)
    const loaded = await history.open(fork).load()
    expect(loaded.messages).toEqual(chat)
    expect(loaded.sharing).toBeUndefined()
    expect((await history.open(ids[0] as string).load()).sharing).toHaveLength(1)
  })
})
