import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT } from '../../shared/ipc-layout'
import { openSettingsStore } from './settings-store'

it('adds connection selections without losing v2 API model settings or provider choice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-models-'))
  try {
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({ version: 2, model: 'claude-opus-5-5', provider: 'codex-subscription' }),
    )
    const store = await openSettingsStore(file)
    expect(store.selection('codex-subscription')).toBeNull()
    await store.setSelection('codex-subscription', 'gpt-5.6-terra')
    await store.setSelection('claude-subscription', 'sonnet')
    await store.setConnection('claude-subscription')
    await store.setModel('claude-sonnet-5-5')
    const reopened = await openSettingsStore(file)
    expect(reopened.selection('codex-subscription')).toBe('gpt-5.6-terra')
    expect(reopened.selection('claude-subscription')).toBe('sonnet')
    expect(reopened.connection).toBe('claude-subscription')
    await reopened.setSelection('codex-subscription', null)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 3,
      model: 'claude-sonnet-5-5',
      connectionModels: { 'claude-subscription': 'sonnet' },
    })
    await expect(reopened.setSelection('codex-subscription', 'bad\nsecret')).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('ignores malformed additive preferences while retaining valid legacy settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-models-'))
  try {
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        model: 'claude-opus-5-5',
        provider: 'codex-subscription',
        providerModels: { unknown: 'model' },
      }),
    )
    const store = await openSettingsStore(file)
    expect(store.connection).toBe('codex-subscription')
    expect(store.model).toBe('claude-opus-5-5')
    expect(store.selection('codex-subscription')).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps the layout across restarts, next to the other settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'layout-settings-'))
  try {
    const file = join(dir, 'settings.json')
    const store = await openSettingsStore(file)
    expect(store.layout).toEqual(DEFAULT_LAYOUT)
    const saved = await store.setLayout({
      ...DEFAULT_LAYOUT,
      leftOpen: false,
      rightWidth: 360,
      rightTab: 'git',
      path: 'C:\\Users\\me\\Projects',
    })
    expect(saved).toEqual({ ...DEFAULT_LAYOUT, leftOpen: false, rightWidth: 360, rightTab: 'git' })
    // Other writes keep it, and it keeps them.
    await store.setTheme('dark')
    await store.setConnection('codex-subscription')
    const reopened = await openSettingsStore(file)
    expect(reopened.layout).toEqual(saved)
    expect(reopened.theme).toBe('dark')
    expect(reopened.connection).toBe('codex-subscription')
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(onDisk['layout']).toEqual(saved)
    expect(JSON.stringify(onDisk)).not.toContain('Projects')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('starts from the default layout when the saved one is missing, invalid or from another version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'layout-settings-'))
  try {
    const file = join(dir, 'settings.json')
    for (const layout of [
      undefined,
      'wide',
      { version: 99, leftOpen: false },
      { version: 1, leftWidth: -5 },
    ]) {
      await writeFile(file, JSON.stringify({ version: 2, model: 'claude-opus-5-5', layout }))
      const store = await openSettingsStore(file)
      expect(store.model).toBe('claude-opus-5-5')
      expect(store.layout).toEqual(
        typeof layout === 'object' && layout.version === 1
          ? { ...DEFAULT_LAYOUT, leftWidth: 220 }
          : DEFAULT_LAYOUT,
      )
    }
    await writeFile(file, '{not json')
    expect((await openSettingsStore(file)).layout).toEqual(DEFAULT_LAYOUT)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('serializes layout writes with the other settings writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'layout-settings-'))
  try {
    const file = join(dir, 'settings.json')
    const store = await openSettingsStore(file)
    await Promise.all([
      store.setLayout({ ...DEFAULT_LAYOUT, leftWidth: 250 }),
      store.setTheme('light'),
      store.setLayout({ ...DEFAULT_LAYOUT, leftWidth: 260 }),
    ])
    const reopened = await openSettingsStore(file)
    expect(reopened.layout.leftWidth).toBe(260)
    expect(reopened.theme).toBe('light')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('settings v3 migration', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })
  const fileWith = async (content: unknown): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'settings-v3-'))
    dirs.push(dir)
    const file = join(dir, 'settings.json')
    if (content !== undefined) await writeFile(file, JSON.stringify(content))
    return file
  }
  const BUILTIN = [
    { id: 'claude-subscription' },
    { id: 'codex-subscription' },
    { id: 'anthropic-api' },
  ]

  it('migrates every v2 field losslessly, and saves version 3 on the first write', async () => {
    const layout = { ...DEFAULT_LAYOUT, leftOpen: false, rightTab: 'git' }
    const v2 = {
      version: 2,
      model: 'claude-opus-5-5',
      provider: 'codex-subscription',
      providerModels: { 'codex-subscription': 'gpt-5.6-sol', 'claude-subscription': 'sonnet' },
      theme: 'dark',
      layout,
    }
    const file = await fileWith(v2)
    const store = await openSettingsStore(file)
    expect(store.connection).toBe('codex-subscription')
    expect(store.selection('codex-subscription')).toBe('gpt-5.6-sol')
    expect(store.selection('claude-subscription')).toBe('sonnet')
    expect(store.model).toBe('claude-opus-5-5')
    expect(store.theme).toBe('dark')
    expect(store.layout).toEqual(layout)
    expect(store.connections).toEqual(BUILTIN)
    expect(store.showPersonalUseConnections).toBe(true)
    // Reading never rewrites the file.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(v2)
    await store.setTheme('light')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 3,
      model: 'claude-opus-5-5',
      connection: 'codex-subscription',
      connectionModels: { 'codex-subscription': 'gpt-5.6-sol', 'claude-subscription': 'sonnet' },
      connections: BUILTIN,
      showPersonalUseConnections: true,
      theme: 'light',
      layout,
    })
  })

  it.each([
    ['v1', { version: 1, model: 'claude-haiku-5-5' }],
    ['v2 without a provider', { version: 2, model: 'claude-haiku-5-5' }],
    ['v2 with an unknown provider', { version: 2, model: 'claude-haiku-5-5', provider: 'evil' }],
    [
      'v1 naming a provider (v1 had none)',
      { version: 1, model: 'claude-haiku-5-5', provider: 'codex-subscription' },
    ],
  ])('reads a %s file with the API default', async (_name, content) => {
    const store = await openSettingsStore(await fileWith(content))
    expect(store.connection).toBe('anthropic-api')
    expect(store.model).toBe('claude-haiku-5-5')
    expect(store.connections).toEqual(BUILTIN)
  })

  it('starts from the defaults with no file, or an unreadable one', async () => {
    for (const file of [await fileWith(undefined), await fileWith('{not json')]) {
      const store = await openSettingsStore(file)
      expect(store.connection).toBe('anthropic-api')
      expect(store.connections).toEqual(BUILTIN)
      expect(store.showPersonalUseConnections).toBe(true)
      expect(store.theme).toBe('system')
    }
  })

  it('round-trips v3 across a restart, keeping theme, model and layout untouched', async () => {
    const file = await fileWith({
      version: 2,
      model: 'claude-opus-5-5',
      provider: 'claude-subscription',
      theme: 'dark',
    })
    const store = await openSettingsStore(file)
    await store.setConnection('codex-subscription')
    await store.setSelection('codex-subscription', 'gpt-5.6-terra')
    await store.setShowPersonalUseConnections(false)
    await store.setLayout({ ...DEFAULT_LAYOUT, rightWidth: 400 })
    const reopened = await openSettingsStore(file)
    expect(reopened.connection).toBe('codex-subscription')
    expect(reopened.selection('codex-subscription')).toBe('gpt-5.6-terra')
    expect(reopened.showPersonalUseConnections).toBe(false)
    expect(reopened.model).toBe('claude-opus-5-5')
    expect(reopened.theme).toBe('dark')
    expect(reopened.layout).toEqual({ ...DEFAULT_LAYOUT, rightWidth: 400 })
    expect(reopened.connections).toEqual(BUILTIN)
    // And once more: a v3 file reads back as it was written.
    const again = await openSettingsStore(file)
    expect(again.connection).toBe('codex-subscription')
    expect(again.showPersonalUseConnections).toBe(false)
  })

  it('keeps a well-formed connection this build does not know, for main to check', async () => {
    const file = await fileWith({
      version: 3,
      model: 'claude-opus-5-5',
      connection: 'openai-api',
      connectionModels: { 'openai-api': 'gpt-5.6' },
      connections: [{ id: 'anthropic-api' }, { id: 'openai-api' }, { id: 'openai-api' }],
      showPersonalUseConnections: true,
    })
    const store = await openSettingsStore(file)
    expect(store.connection).toBe('openai-api')
    expect(store.selection('openai-api')).toBe('gpt-5.6')
    expect(store.connections).toEqual([{ id: 'anthropic-api' }, { id: 'openai-api' }])
  })

  it('drops malformed v3 fields to their defaults, never a path', async () => {
    const file = await fileWith({
      version: 3,
      model: 'claude-opus-5-5',
      connection: '../../evil',
      connectionModels: { '../x': 'm' },
      connections: [{ id: 'C:\\Windows' }],
      showPersonalUseConnections: 'yes',
    })
    const store = await openSettingsStore(file)
    expect(store.connection).toBe('anthropic-api')
    expect(store.selection('anthropic-api')).toBeNull()
    expect(store.connections).toEqual(BUILTIN)
    expect(store.showPersonalUseConnections).toBe(true)
    expect(store.model).toBe('claude-opus-5-5')
    await expect(store.setConnection('../x')).rejects.toThrow('Unknown provider.')
    await expect(store.setSelection('../x', 'm')).rejects.toThrow('Unknown provider.')
  })

  it('adds a newly chosen connection to the configured list', async () => {
    const file = await fileWith({
      version: 3,
      model: 'claude-opus-5-5',
      connection: 'anthropic-api',
      connectionModels: {},
      connections: [{ id: 'anthropic-api' }],
      showPersonalUseConnections: true,
    })
    const store = await openSettingsStore(file)
    await store.setConnection('codex-subscription')
    expect((await openSettingsStore(file)).connections).toEqual([
      { id: 'anthropic-api' },
      { id: 'codex-subscription' },
    ])
  })
  it('adds and removes configured connections, keeping history and the current choice', async () => {
    const file = await fileWith({
      version: 3,
      model: 'claude-opus-5-5',
      connection: 'anthropic-api',
      connectionModels: { 'codex-subscription': 'gpt-5.6-terra' },
      connections: [{ id: 'anthropic-api' }],
      showPersonalUseConnections: true,
    })
    const store = await openSettingsStore(file)
    await store.addConnection('codex-subscription')
    await store.addConnection('codex-subscription')
    expect(store.connections).toEqual([{ id: 'anthropic-api' }, { id: 'codex-subscription' }])
    await store.removeConnection('codex-subscription')
    const reopened = await openSettingsStore(file)
    expect(reopened.connections).toEqual([{ id: 'anthropic-api' }])
    // Removing a connection leaves its saved model choice alone.
    expect(reopened.selection('codex-subscription')).toBe('gpt-5.6-terra')
  })

  it('refuses to remove the current connection or to add a malformed id', async () => {
    const file = await fileWith({
      version: 3,
      model: 'claude-opus-5-5',
      connection: 'anthropic-api',
      connectionModels: {},
      connections: [{ id: 'anthropic-api' }],
      showPersonalUseConnections: true,
    })
    const store = await openSettingsStore(file)
    await expect(store.removeConnection('anthropic-api')).rejects.toThrow('Switch to another')
    await expect(store.addConnection('../x')).rejects.toThrow('Unknown provider.')
    await expect(store.removeConnection('../x')).rejects.toThrow('Unknown provider.')
    expect(store.connections).toEqual([{ id: 'anthropic-api' }])
  })
})

it('keeps the ChatGPT host id and registrations, and refuses anything that does not validate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-settings-'))
  try {
    const file = join(dir, 'settings.json')
    const store = await openSettingsStore(file)
    expect(store.chatgptAuth).toBeNull()
    const value = {
      hostId: 'urn:uuid:4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      accounts: [{ subject: 'user-1', clientId: 'oaiapp_abc' }],
      current: 'user-1',
    }
    await store.setChatgptAuth(value)
    await store.setTheme('dark')
    const reopened = await openSettingsStore(file)
    expect(reopened.chatgptAuth).toEqual(value)
    expect(reopened.theme).toBe('dark')
    await expect(
      reopened.setChatgptAuth({ ...value, hostId: 'person@example.com' }),
    ).rejects.toThrow()
    await expect(
      reopened.setChatgptAuth({ ...value, accounts: [{ subject: 'a b', clientId: 'x' }] }),
    ).rejects.toThrow()
    expect(reopened.chatgptAuth).toEqual(value)
    await writeFile(file, JSON.stringify({ version: 3, chatgptAuth: { hostId: 'bad' } }))
    expect((await openSettingsStore(file)).chatgptAuth).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
