import { createContext, useContext, useEffect, useState } from 'react'
import type { ConnectionId, ConnectionInfo } from '../../shared/ipc-connections'
import { useApi } from './api'

/** undefined: no provider above, so each user loads its own copy (tests render parts alone). */
const ConnectionsContext = createContext<ConnectionInfo[] | null | undefined>(undefined)

/** Null until main has answered; an empty list when it could not. */
function useLoadedConnections(skip: boolean): ConnectionInfo[] | null {
  const api = useApi()
  const [list, setList] = useState<ConnectionInfo[] | null>(null)
  useEffect(() => {
    if (skip) return
    let current = true
    api.connections.list().then(
      (next) => {
        if (current) setList(next)
      },
      (error: unknown) => {
        console.error('connections.list failed', error)
        if (current) setList([])
      },
    )
    return () => {
      current = false
    }
  }, [api, skip])
  return list
}

/** Loads the connection list once for everything below it (one IPC call for the app). */
export function ConnectionsProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const list = useLoadedConnections(false)
  return <ConnectionsContext value={list}>{children}</ConnectionsContext>
}

/** The connections main offers, in Settings order: labels and capabilities, never credentials. */
export function useConnections(): ConnectionInfo[] | null {
  const shared = useContext(ConnectionsContext)
  const own = useLoadedConnections(shared !== undefined)
  return shared === undefined ? own : shared
}

export function connectionOf(
  list: readonly ConnectionInfo[] | null,
  id: ConnectionId | null | undefined,
): ConnectionInfo | undefined {
  return id ? list?.find((connection) => connection.id === id) : undefined
}
