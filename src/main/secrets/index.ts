import * as nodeFs from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface SafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}
export type KeyStoreFs = Pick<typeof nodeFs, 'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'rm'>

/** Instantiate after Electron app.whenReady(), passing app.getPath('userData') and safeStorage. */
export function createApiKeyStore({
  userDataPath,
  safeStorage,
  fs = nodeFs,
}: {
  userDataPath: string
  safeStorage: SafeStorage
  fs?: KeyStoreFs
}) {
  const path = join(userDataPath, 'anthropic-api-key.enc')
  const requireEncryption = (): void => {
    if (
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw new Error('OS encryption is unavailable. API key storage is disabled.')
  }
  // Serialize operations so set/clear cannot race within this store instance.
  let pending: Promise<unknown> = Promise.resolve()
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }
  async function read(): Promise<string | null> {
    let data: Buffer
    try {
      data = await fs.readFile(path)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return null
      // Raw filesystem errors may expose sensitive paths.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Could not read the encrypted API key.')
    }
    requireEncryption()
    try {
      const key = safeStorage.decryptString(data)
      if (!key.trim()) throw new Error('Empty key')
      return key
    } catch {
      throw new Error(
        'Stored API key is corrupt or cannot be decrypted. Clear it and enter it again.',
      )
    }
  }
  async function removeTemporary(path: string): Promise<void> {
    try {
      await fs.rm(path, { force: true })
    } catch {
      throw new Error('Could not clean up the temporary encrypted API key file.')
    }
  }
  return {
    get: () => serial(read),
    hasKey: () => serial(async () => (await read()) !== null),
    set: (key: string) =>
      serial(async () => {
        requireEncryption()
        if (!key.trim()) throw new Error('API key must not be empty.')
        let encrypted: Buffer
        try {
          encrypted = safeStorage.encryptString(key)
        } catch {
          throw new Error('Could not encrypt the API key.')
        }
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await fs.mkdir(userDataPath, { recursive: true })
          await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' })
          await fs.rename(temporary, path)
        } catch {
          throw new Error('Could not save the encrypted API key.')
        } finally {
          await removeTemporary(temporary)
        }
      }),
    clear: () =>
      serial(async () => {
        try {
          await fs.rm(path, { force: true })
        } catch {
          throw new Error('Could not clear the encrypted API key.')
        }
      }),
  }
}
