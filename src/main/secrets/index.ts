import * as nodeFs from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONNECTION_ID, type ConnectionId } from '../../shared/ipc-connections'

export interface SafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}
export type KeyStoreFs = Pick<
  typeof nodeFs,
  'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'rm' | 'stat'
>

/** One connection's API key. */
export interface ApiKeyStore {
  get: () => Promise<string | null>
  hasKey: () => Promise<boolean>
  set: (key: string) => Promise<void>
  clear: () => Promise<void>
}

/** Every API-key connection's key, each in its own file: userData/secrets/<id>.enc. */
export interface KeyStore {
  /** Throws for an id that is not a safe single path segment. */
  forConnection: (id: ConnectionId) => ApiKeyStore
}

/** Where a key lived before keys were per connection; moved on first use. */
const LEGACY_FILES: Partial<Record<ConnectionId, string>> = {
  'anthropic-api': 'anthropic-api-key.enc',
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

/** Instantiate after Electron app.whenReady(), passing app.getPath('userData') and safeStorage. */
export function createKeyStore({
  userDataPath,
  safeStorage,
  fs = nodeFs,
}: {
  userDataPath: string
  safeStorage: SafeStorage
  fs?: KeyStoreFs
}): KeyStore {
  const directory = join(userDataPath, 'secrets')
  const requireEncryption = (): void => {
    if (
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw new Error('OS encryption is unavailable. API key storage is disabled.')
  }
  /** Best effort: a leftover temp file holds only encrypted bytes, so it must not fail a save. */
  async function removeTemporary(path: string): Promise<void> {
    try {
      await fs.rm(path, { force: true })
    } catch {
      // Ignored: rejecting here would turn a successful save into a failure or mask the real error.
    }
  }

  function open(id: ConnectionId): ApiKeyStore {
    const path = join(directory, `${id}.enc`)
    const legacyName = LEGACY_FILES[id]
    const legacy = legacyName ? join(userDataPath, legacyName) : undefined
    let migrated = !legacy
    // Serialize operations so set/clear cannot race within this connection's store.
    let pending: Promise<unknown> = Promise.resolve()
    function serial<T>(operation: () => Promise<T>): Promise<T> {
      const result = pending.then(operation)
      pending = result.catch(() => {})
      return result
    }
    const exists = async (file: string): Promise<boolean> => {
      try {
        await fs.stat(file)
        return true
      } catch (error) {
        if (isMissing(error)) return false
        throw error
      }
    }
    /**
     * Moves the pre-connection key file into place, as it is: the same encrypted
     * bytes, never decrypted to move. A key already in the new place wins.
     */
    async function migrate(): Promise<void> {
      if (migrated || !legacy) return
      try {
        if (!(await exists(path)) && (await exists(legacy))) {
          await fs.mkdir(directory, { recursive: true, mode: 0o700 })
          await fs.rename(legacy, path)
        }
      } catch {
        // Raw filesystem errors may expose sensitive paths.
        throw new Error('Could not read the encrypted API key.')
      }
      migrated = true
    }
    async function read(): Promise<string | null> {
      await migrate()
      let data: Buffer
      try {
        data = await fs.readFile(path)
      } catch (error) {
        if (isMissing(error)) return null
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
    return {
      get: () => serial(read),
      hasKey: () => serial(async () => (await read()) !== null),
      set: (key: string) =>
        serial(async () => {
          requireEncryption()
          if (!key.trim()) throw new Error('API key must not be empty.')
          await migrate()
          let encrypted: Buffer
          try {
            encrypted = safeStorage.encryptString(key)
          } catch {
            throw new Error('Could not encrypt the API key.')
          }
          const temporary = `${path}.${randomUUID()}.tmp`
          try {
            await fs.mkdir(directory, { recursive: true, mode: 0o700 })
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
            // The old file too, so a cleared key cannot come back by migration.
            for (const file of legacy ? [path, legacy] : [path]) await fs.rm(file, { force: true })
          } catch {
            throw new Error('Could not clear the encrypted API key.')
          }
        }),
    }
  }

  // One store per connection, so every caller shares its serial queue.
  const stores = new Map<ConnectionId, ApiKeyStore>()
  return {
    forConnection(id) {
      if (!CONNECTION_ID.test(id)) throw new Error('Unknown provider.')
      let store = stores.get(id)
      if (!store) {
        store = open(id)
        stores.set(id, store)
      }
      return store
    },
  }
}
