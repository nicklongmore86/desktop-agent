import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
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
