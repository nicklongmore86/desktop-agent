import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiKeyStore, type SafeStorage } from './index'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'agent-key-'))
  directories.push(path)
  const safeStorage: SafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: vi.fn(() => Buffer.from('encrypted-payload')),
    decryptString: (data) => {
      if (data.toString() !== 'encrypted-payload') throw new Error('bad')
      return 'secret-key'
    },
  }
  return { path, safeStorage, store: createApiKeyStore({ userDataPath: path, safeStorage }) }
}
describe('encrypted API key store', () => {
  it('round-trips, replaces, and clears encrypted data across instances', async () => {
    const { path, safeStorage, store } = await fixture()
    expect(await store.get()).toBeNull()
    expect(await store.hasKey()).toBe(false)
    await store.set('secret-key')
    await store.set('secret-key')
    expect((await readFile(join(path, 'anthropic-api-key.enc'))).toString()).not.toContain(
      'secret-key',
    )
    const reopened = createApiKeyStore({ userDataPath: path, safeStorage })
    expect(await reopened.get()).toBe('secret-key')
    expect(await reopened.hasKey()).toBe(true)
    await store.clear()
    await store.clear()
    expect(await store.hasKey()).toBe(false)
  })
  it.each(['unavailable', 'basic_text'])('refuses %s encryption', async (mode) => {
    const { store, safeStorage, path } = await fixture()
    safeStorage.isEncryptionAvailable = () => mode !== 'unavailable'
    safeStorage.getSelectedStorageBackend = () => 'basic_text'
    await expect(store.set('secret-key')).rejects.toThrow('OS encryption is unavailable')
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    await expect(readFile(join(path, 'anthropic-api-key.enc'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it('reports corruption without leaking content, and permits clearing', async () => {
    const { store, path } = await fixture()
    await writeFile(join(path, 'anthropic-api-key.enc'), 'corrupt-secret')
    await expect(store.get()).rejects.toThrow('corrupt or cannot be decrypted')
    await expect(store.hasKey()).rejects.toThrow('corrupt or cannot be decrypted')
    await store.clear()
    expect(await store.get()).toBeNull()
  })
  it('serializes set followed by clear', async () => {
    const { store } = await fixture()
    await Promise.all([store.set('secret-key'), store.clear()])
    expect(await store.hasKey()).toBe(false)
  })
})
