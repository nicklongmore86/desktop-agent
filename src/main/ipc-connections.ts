import { z } from 'zod'
import {
  CONNECTION_ID,
  connectionsChannels,
  type ConnectionId,
  type ConnectionInfo,
} from '../shared/ipc-connections'
import type { IpcHandle } from './ipc-features'

export interface ConnectionsService {
  /** The connections the user can choose now (personal-use ones only when shown). */
  list: () => ConnectionInfo[]
  /** True for a registered connection the user can choose now. */
  available: (id: ConnectionId) => boolean
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
}
