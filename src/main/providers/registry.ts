import {
  ACCESS_TYPES,
  CONNECTION_ID,
  VENDORS,
  type ConnectionId,
  type ConnectionInfo,
} from '../../shared/ipc-connections'
import { connectionInfo, type ConnectionAdapter } from './connection'

/**
 * Every connection main knows, in registration order (the order Settings lists
 * them). An id the renderer sends is only ever used after a lookup here.
 */
export class ConnectionRegistry {
  private readonly adapters = new Map<ConnectionId, ConnectionAdapter>()

  /** Throws for a malformed or duplicate id, or an unknown vendor or access type. */
  register(adapter: ConnectionAdapter): void {
    if (!CONNECTION_ID.test(adapter.id)) throw new Error(`Invalid connection id: ${adapter.id}`)
    if (this.adapters.has(adapter.id))
      throw new Error(`Connection already registered: ${adapter.id}`)
    if (!VENDORS.includes(adapter.vendor)) throw new Error(`Unknown vendor: ${adapter.vendor}`)
    if (!ACCESS_TYPES.includes(adapter.access))
      throw new Error(`Unknown access type: ${adapter.access}`)
    this.adapters.set(adapter.id, adapter)
  }

  has(id: unknown): id is ConnectionId {
    return typeof id === 'string' && this.adapters.has(id)
  }

  get(id: ConnectionId): ConnectionAdapter | undefined {
    return this.adapters.get(id)
  }

  /** The adapter for a known id; throws the same message the IPC check uses otherwise. */
  require(id: ConnectionId): ConnectionAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error('Unknown provider.')
    return adapter
  }

  ids(): ConnectionId[] {
    return [...this.adapters.keys()]
  }

  /** Descriptions for the renderer: personal-use connections only when they are shown. */
  list({ personalUse }: { personalUse: boolean }): ConnectionInfo[] {
    return [...this.adapters.values()]
      .filter((adapter) => personalUse || !adapter.personalUseOnly)
      .map(connectionInfo)
  }
}
