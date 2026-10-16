import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DEFAULT_LAYOUT } from '../../shared/ipc-layout'
import { openSettingsStore } from './settings-store'

it('adds provider selections without losing v2 API model settings or provider choice', async () => {
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
    await store.setProvider('claude-subscription')
    await store.setModel('claude-sonnet-5-5')
    const reopened = await openSettingsStore(file)
    expect(reopened.selection('codex-subscription')).toBe('gpt-5.6-terra')
    expect(reopened.selection('claude-subscription')).toBe('sonnet')
    expect(reopened.provider).toBe('claude-subscription')
    await reopened.setSelection('codex-subscription', null)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 2,
      model: 'claude-sonnet-5-5',
      providerModels: { 'claude-subscription': 'sonnet' },
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
    expect(store.provider).toBe('codex-subscription')
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
    await store.setProvider('codex-subscription')
    const reopened = await openSettingsStore(file)
    expect(reopened.layout).toEqual(saved)
    expect(reopened.theme).toBe('dark')
    expect(reopened.provider).toBe('codex-subscription')
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
