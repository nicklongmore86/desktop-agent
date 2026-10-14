import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MODEL } from '../agent'
import { createConversationStore } from './conversation-store'
import { MODEL_OPTIONS, openSettingsStore } from './settings-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-store-'))
  directories.push(path)
  return path
}

describe('conversation store', () => {
  it('round-trips, clears and leaves no temp files', async () => {
    const dir = await tempDir()
    const file = join(dir, 'nested', 'conversation.json')
    const store = createConversationStore(file)
    expect(await store.load()).toEqual({ messages: [], error: null })
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'hello' }] },
    ]
    await store.save(messages)
    expect(await createConversationStore(file).load()).toEqual({ messages, error: null })
    expect(await readdir(join(dir, 'nested'))).toEqual(['conversation.json'])
    await store.clear()
    await store.clear()
    expect(await store.load()).toEqual({ messages: [], error: null })
  })

  it.each([
    ['not json', '{'],
    ['wrong shape', '{"version":1,"messages":[{"role":"system","content":"x"}]}'],
    ['wrong version', '{"version":2,"messages":[]}'],
  ])('starts fresh for a %s file and says so', async (_name, text) => {
    const file = join(await tempDir(), 'conversation.json')
    await writeFile(file, text)
    const loaded = await createConversationStore(file).load()
    expect(loaded.messages).toEqual([])
    expect(loaded.error).toMatch(/could not be read/)
  })
})

describe('settings store', () => {
  it('defaults to the agent model and persists a chosen one', async () => {
    const file = join(await tempDir(), 'settings.json')
    const store = await openSettingsStore(file)
    expect(store.model).toBe(DEFAULT_MODEL)
    expect(store.view()).toMatchObject({ model: DEFAULT_MODEL, defaultModel: DEFAULT_MODEL })
    expect(store.view().options.map((o) => o.id)).toContain(DEFAULT_MODEL)
    const other = MODEL_OPTIONS.find((o) => o.id !== DEFAULT_MODEL)?.id ?? DEFAULT_MODEL
    await store.setModel(other)
    expect((await openSettingsStore(file)).model).toBe(other)
  })

  it('refuses unknown models and ignores bad files', async () => {
    const file = join(await tempDir(), 'settings.json')
    const store = await openSettingsStore(file)
    await expect(store.setModel('gpt-4')).rejects.toThrow('Unknown model.')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(file, '{"version":1,"model":"made-up"}')
    expect((await openSettingsStore(file)).model).toBe(DEFAULT_MODEL)
    await writeFile(file, 'garbage')
    expect((await openSettingsStore(file)).model).toBe(DEFAULT_MODEL)
  })
})
