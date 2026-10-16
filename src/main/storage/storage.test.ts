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

describe('conversation validation', () => {
  const user = (content: unknown) => ({ role: 'user', content })
  const assistant = (content: unknown) => ({ role: 'assistant', content })
  const toolUse = (id = 't1', input: unknown = { path: 'C:\\x' }) => ({
    type: 'tool_use',
    id,
    name: 'read_file',
    input,
  })
  const toolResult = (id = 't1', extra: Record<string, unknown> = {}) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: 'ok',
    ...extra,
  })

  async function load(messages: unknown[]) {
    const file = join(await tempDir(), 'conversation.json')
    await writeFile(file, JSON.stringify({ version: 1, messages }))
    return createConversationStore(file).load()
  }

  it('accepts a well-formed tool conversation, including consecutive turns', async () => {
    const messages = [
      user('Read it'),
      assistant([{ type: 'text', text: 'Sure.', citations: null }, toolUse()]),
      user([toolResult('t1', { is_error: false })]),
      assistant([{ type: 'text', text: 'Partly…' }]),
      // pause_turn continuation and a run that failed before replying.
      assistant('Done.'),
      user('Again'),
      user([{ type: 'text', text: 'Please' }]),
    ]
    expect(await load(messages)).toEqual({ messages, error: null })
  })

  it.each([
    ['a non-string text block', [user([{ type: 'text', text: 42 }])]],
    ['an empty text block', [user([{ type: 'text', text: '  ' }])]],
    ['empty string content', [user('')]],
    ['empty block array', [user([])]],
    ['bad citations', [user([{ type: 'text', text: 'x', citations: 'no' }])]],
    ['an unknown block type', [user([{ type: 'image', source: {} }])]],
    ['a thinking block', [user('hi'), assistant([{ type: 'thinking', thinking: 'x' }])]],
    ['a block without a type', [user([{ text: 'x' }])]],
    ['a non-object block', [user(['x'])]],
    ['an unknown role', [{ role: 'system', content: 'x' }]],
    ['a tool_use from the user', [user([toolUse()]), assistant('x')]],
    ['a tool_result from the assistant', [user('x'), assistant([toolResult()])]],
    [
      'tool_use without a string id',
      [user('x'), assistant([toolUse(7 as never)]), user([toolResult()])],
    ],
    [
      'tool_use with array input',
      [user('x'), assistant([toolUse('t1', [])]), user([toolResult()])],
    ],
    [
      'tool_use with null input',
      [user('x'), assistant([toolUse('t1', null)]), user([toolResult()])],
    ],
    [
      'tool_result with numeric content',
      [user('x'), assistant([toolUse()]), user([toolResult('t1', { content: 5 })])],
    ],
    [
      'tool_result with non-text content parts',
      [
        user('x'),
        assistant([toolUse()]),
        user([toolResult('t1', { content: [{ type: 'image' }] })]),
      ],
    ],
    [
      'tool_result with a string is_error',
      [user('x'), assistant([toolUse()]), user([toolResult('t1', { is_error: 'yes' })])],
    ],
    ['a history starting with the assistant', [assistant('hi')]],
    ['an unanswered tool call', [user('x'), assistant([toolUse()])]],
    ['a tool call answered by the assistant', [user('x'), assistant([toolUse()]), assistant('y')]],
    [
      'a result for a different call',
      [user('x'), assistant([toolUse('t1')]), user([toolResult('t2')])],
    ],
    [
      'a missing result',
      [user('x'), assistant([toolUse('t1'), toolUse('t2')]), user([toolResult('t1')])],
    ],
    [
      'a duplicated result',
      [user('x'), assistant([toolUse('t1')]), user([toolResult('t1'), toolResult('t1')])],
    ],
    ['an orphan tool result', [user('x'), assistant('y'), user([toolResult()])]],
    ...['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'].map(
      (type): [string, unknown[]] => [`a block of type "${type}"`, [user([{ type, text: 42 }])]],
    ),
    ...['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'].map(
      (role): [string, unknown[]] => [`a message with role "${role}"`, [{ role, content: 'x' }]],
    ),
  ])('starts fresh for %s', async (_name, messages) => {
    const loaded = await load(messages)
    expect(loaded.messages).toEqual([])
    expect(loaded.error).toBe('The saved conversation could not be read, so a new one was started.')
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

describe('theme setting', () => {
  it('defaults to system, persists a choice, and keeps model and provider', async () => {
    const file = join(await tempDir(), 'settings.json')
    const store = await openSettingsStore(file)
    expect(store.theme).toBe('system')
    await store.setProvider('codex-subscription')
    expect(await store.setTheme('dark')).toBe('dark')
    const reopened = await openSettingsStore(file)
    expect(reopened.theme).toBe('dark')
    expect(reopened.provider).toBe('codex-subscription')
    // Changing the provider afterwards does not reset the theme.
    await reopened.setProvider('anthropic-api')
    expect((await openSettingsStore(file)).theme).toBe('dark')
  })

  it('refuses unknown themes and ignores unknown stored ones', async () => {
    const file = join(await tempDir(), 'settings.json')
    const store = await openSettingsStore(file)
    await expect(store.setTheme('sepia' as never)).rejects.toThrow('Unknown theme.')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(file, '{"version":2,"model":"claude-sonnet-5-5","provider":"anthropic-api"}')
    expect((await openSettingsStore(file)).theme).toBe('system')
    await writeFile(file, '{"version":2,"provider":"anthropic-api","theme":"sepia"}')
    expect((await openSettingsStore(file)).theme).toBe('system')
  })
})

it('persists concurrent model and provider selections together across restart', async () => {
  const file = join(await tempDir(), 'settings.json')
  const store = await openSettingsStore(file)
  const other = MODEL_OPTIONS.find((option) => option.id !== DEFAULT_MODEL)?.id ?? DEFAULT_MODEL
  await Promise.all([store.setModel(other), store.setProvider('codex-subscription')])
  const reopened = await openSettingsStore(file)
  expect(reopened.model).toBe(other)
  expect(reopened.provider).toBe('codex-subscription')
})
