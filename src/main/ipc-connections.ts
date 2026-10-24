import { z } from 'zod'
import {
  CONNECTION_ID,
  connectionsChannels,
  type ConnectionBaseUrl,
  type ConnectionId,
  type ConnectionInfo,
  type ConnectionsState,
  type ConnectionVision,
} from '../shared/ipc-connections'
import type { ProviderStatus } from '../shared/ipc'
import type { IpcHandle } from './ipc-features'

export interface ConnectionsService {
  /** The connections the user can choose now (personal-use ones only when shown). */
  list: () => ConnectionInfo[]
  /** True for a registered connection the user can choose now. */
  available: (id: ConnectionId) => boolean
  /** The set-up connections, the current one, and whether personal-use ones are shown. */
  state: () => ConnectionsState
  /** A registered connection's status, whether or not chats go to it. Never throws. */
  status: (id: ConnectionId) => Promise<ProviderStatus>
  /** Adds an available connection to the set-up ones. */
  add: (id: ConnectionId) => Promise<ConnectionsState>
  /** Removes one; throws for the current connection (chats go there). History is untouched. */
  remove: (id: ConnectionId) => Promise<ConnectionsState>
  /** Throws when hiding would leave chats on a personal-use connection. */
  setShowPersonalUse: (show: boolean) => Promise<ConnectionsState>
  /** A local connection's API root; rejects for one without. */
  baseUrl: (id: ConnectionId) => Promise<ConnectionBaseUrl>
  /** Validates (loopback only) and saves; a refused URL comes back as `error`. */
  setBaseUrl: (id: ConnectionId, baseUrl: string | null) => Promise<ConnectionBaseUrl>
  /** Whether images reach the connection's current model. */
  vision: (id: ConnectionId) => Promise<ConnectionVision>
  /** Throws for a connection that does not offer the setting. */
  setVision: (id: ConnectionId, enabled: boolean) => Promise<ConnectionVision>
}

/** The shape of an id: a safe single path segment. The registry decides whether it exists. */
export const connectionIdSchema = z.string().regex(CONNECTION_ID)

/** A connection id from the renderer: well formed and chosen from the registry, or it throws. */
export function parseConnectionId(
  value: unknown,
  connections: Pick<ConnectionsService, 'available'>,
): ConnectionId {
  const parsed = connectionIdSchema.safeParse(value)
  if (!parsed.success || !connections.available(parsed.data)) throw new Error('Unknown provider.')
  return parsed.data
}

export function registerConnectionsHandlers(
  handle: IpcHandle,
  connections: ConnectionsService,
): void {
  handle(connectionsChannels.connectionsList, (...args) => {
    if (args.length) throw new Error('Listing connections takes no arguments.')
    return connections.list()
  })
  handle(connectionsChannels.connectionsState, (...args) => {
    if (args.length) throw new Error('Reading connections takes no arguments.')
    return connections.state()
  })
  handle(connectionsChannels.connectionsStatus, (...args) => {
    if (args.length !== 1) throw new Error('Unknown provider.')
    return connections.status(parseConnectionId(args[0], connections))
  })
  handle(connectionsChannels.connectionsAdd, (...args) => {
    if (args.length !== 1) throw new Error('Unknown provider.')
    return connections.add(parseConnectionId(args[0], connections))
  })
  handle(connectionsChannels.connectionsRemove, (...args) => {
    if (args.length !== 1) throw new Error('Unknown provider.')
    return connections.remove(parseConnectionId(args[0], connections))
  })
  handle(connectionsChannels.connectionsSetShowPersonalUse, (...args) => {
    const show = z.tuple([z.boolean()]).safeParse(args)
    if (!show.success) throw new Error('Invalid choice.')
    return connections.setShowPersonalUse(show.data[0])
  })
  handle(connectionsChannels.connectionsBaseUrl, (id) =>
    connections.baseUrl(parseConnectionId(id, connections)),
  )
  handle(connectionsChannels.connectionsSetBaseUrl, (id, baseUrl) => {
    const connection = parseConnectionId(id, connections)
    if (baseUrl !== null && (typeof baseUrl !== 'string' || baseUrl.length > 2048))
      throw new Error('Enter a valid address.')
    return connections.setBaseUrl(connection, baseUrl)
  })
  handle(connectionsChannels.connectionsVision, (...args) => {
    if (args.length !== 1) throw new Error('Unknown provider.')
    return connections.vision(parseConnectionId(args[0], connections))
  })
  handle(connectionsChannels.connectionsSetVision, (...args) => {
    if (args.length !== 2 || typeof args[1] !== 'boolean') throw new Error('Invalid choice.')
    return connections.setVision(parseConnectionId(args[0], connections), args[1])
  })
}
