import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeyStore, type KeyStoreFs, type SafeStorage } from './index'

const KEY_FILE = join('secrets', 'anthropic-api.enc')
const LEGACY_FILE = 'anthropic-api-key.enc'
const createApiKeyStore = (options: {
  userDataPath: string
  safeStorage: SafeStorage
  fs?: KeyStoreFs
}) => createKeyStore(options).forConnection('anthropic-api')

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
    expect((await readFile(join(path, KEY_FILE))).toString()).not.toContain('secret-key')
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
    if (mode === 'basic_text') safeStorage.getSelectedStorageBackend = () => 'basic_text'
    await expect(store.set('secret-key')).rejects.toThrow('OS encryption is unavailable')
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    await expect(readFile(join(path, KEY_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it('reports corruption without leaking content, and permits clearing', async () => {
    const { store, path } = await fixture()
    // Written where the key lived before connections: it is moved, then fails to decrypt.
    await writeFile(join(path, LEGACY_FILE), 'corrupt-secret')
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
  it('sanitizes EPERM during clear', async () => {
    const { path, safeStorage } = await fixture()
    const store = createApiKeyStore({
      userDataPath: path,
      safeStorage,
      fs: {
        ...fs,
        rm: () =>
          Promise.reject(Object.assign(new Error(`EPERM: ${path}/private-key`), { code: 'EPERM' })),
      },
    })
    const result = store.clear()
    await expect(result).rejects.toThrow('Could not clear the encrypted API key.')
    await expect(result).rejects.not.toThrow(path)
    await expect(result).rejects.not.toHaveProperty('cause')
  })
  it('treats temporary-file cleanup as best effort after a successful save', async () => {
    const { path, safeStorage } = await fixture()
    const rm = vi.fn(() => Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })))
    const store = createApiKeyStore({ userDataPath: path, safeStorage, fs: { ...fs, rm } })
    await expect(store.set('secret-key')).resolves.toBeUndefined()
    expect(rm).toHaveBeenCalledOnce()
    expect(await store.get()).toBe('secret-key')
  })
  it('reports the real save error when cleanup also fails', async () => {
    const { path, safeStorage } = await fixture()
    const store = createApiKeyStore({
      userDataPath: path,
      safeStorage,
      fs: {
        ...fs,
        rename: () => Promise.reject(Object.assign(new Error(`EPERM: ${path}`), { code: 'EPERM' })),
        rm: () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })),
      },
    })
    const result = store.set('secret-key')
    await expect(result).rejects.toThrow('Could not save the encrypted API key.')
    await expect(result).rejects.not.toThrow(path)
  })
  it.each(['writeFile', 'rename'] as const)(
    'removes the temporary file when %s fails',
    async (step) => {
      const { path, safeStorage } = await fixture()
      const failing = {
        ...fs,
        [step]: async (...args: [string, Buffer]) => {
          // Fail after the temporary file exists, as a partial write or a locked target would.
          if (step === 'writeFile') await fs.writeFile(args[0], 'partial')
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        },
      }
      const store = createApiKeyStore({ userDataPath: path, safeStorage, fs: failing })
      await expect(store.set('secret-key')).rejects.toThrow('Could not save the encrypted API key.')
      expect(await fs.readdir(join(path, 'secrets'))).toEqual([])
    },
  )
})

describe('per-connection key files', () => {
  it('keeps each connection in its own file and refuses ids that are not one path segment', async () => {
    const { path, safeStorage } = await fixture()
    const keys = createKeyStore({ userDataPath: path, safeStorage })
    await keys.forConnection('anthropic-api').set('secret-key')
    expect(await keys.forConnection('openai-api').hasKey()).toBe(false)
    await keys.forConnection('openai-api').set('secret-key')
    expect((await fs.readdir(join(path, 'secrets'))).sort()).toEqual([
      'anthropic-api.enc',
      'openai-api.enc',
    ])
    await keys.forConnection('openai-api').clear()
    expect(await keys.forConnection('anthropic-api').hasKey()).toBe(true)
    // The same store (and serial queue) for every caller of one connection.
    expect(keys.forConnection('anthropic-api')).toBe(keys.forConnection('anthropic-api'))
    for (const bad of ['../anthropic-api', 'a/b', 'a\\b', '', '.enc', 'A', 'x'.repeat(65)])
      expect(() => keys.forConnection(bad)).toThrow('Unknown provider.')
  })

  it('moves the pre-connection key file into place, encrypted bytes untouched', async () => {
    const { path, safeStorage } = await fixture()
    await writeFile(join(path, LEGACY_FILE), 'encrypted-payload')
    const store = createApiKeyStore({ userDataPath: path, safeStorage })
    expect(await store.hasKey()).toBe(true)
    expect(await store.get()).toBe('secret-key')
    expect((await readFile(join(path, KEY_FILE))).toString()).toBe('encrypted-payload')
    await expect(readFile(join(path, LEGACY_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    // Across a restart the moved key is still there.
    expect(await createApiKeyStore({ userDataPath: path, safeStorage }).get()).toBe('secret-key')
  })

  it('migrates before a save, so the old key does not linger beside the new one', async () => {
    const { path, safeStorage } = await fixture()
    await writeFile(join(path, LEGACY_FILE), 'encrypted-payload')
    await createApiKeyStore({ userDataPath: path, safeStorage }).set('secret-key')
    await expect(readFile(join(path, LEGACY_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prefers a key already in the new place, and clearing removes both files', async () => {
    const { path, safeStorage } = await fixture()
    await fs.mkdir(join(path, 'secrets'))
    await writeFile(join(path, KEY_FILE), 'encrypted-payload')
    await writeFile(join(path, LEGACY_FILE), 'stale')
    const store = createApiKeyStore({ userDataPath: path, safeStorage })
    expect(await store.get()).toBe('secret-key')
    await store.clear()
    expect(await store.hasKey()).toBe(false)
    // A cleared key cannot come back by migration after a restart.
    expect(await createApiKeyStore({ userDataPath: path, safeStorage }).hasKey()).toBe(false)
  })

  it('refuses the basic_text backend for a migrated key too', async () => {
    const { path, safeStorage } = await fixture()
    await writeFile(join(path, LEGACY_FILE), 'encrypted-payload')
    safeStorage.getSelectedStorageBackend = () => 'basic_text'
    await expect(createApiKeyStore({ userDataPath: path, safeStorage }).get()).rejects.toThrow(
      'OS encryption is unavailable',
    )
  })

  it('reports a failed move without the path', async () => {
    const { path, safeStorage } = await fixture()
    await writeFile(join(path, LEGACY_FILE), 'encrypted-payload')
    const store = createApiKeyStore({
      userDataPath: path,
      safeStorage,
      fs: {
        ...fs,
        rename: () => Promise.reject(Object.assign(new Error(`EPERM: ${path}`), { code: 'EPERM' })),
      },
    })
    const result = store.get()
    await expect(result).rejects.toThrow('Could not read the encrypted API key.')
    await expect(result).rejects.not.toThrow(path)
  })
})
