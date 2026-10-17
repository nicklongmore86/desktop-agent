import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ProviderStatus } from '../../shared/ipc'
import type { ConnectionId, ConnectionInfo, ConnectionsState } from '../../shared/ipc-connections'
import { useApi } from './api'
import { isReady } from './components/connections/flow'

/** undefined: no provider above, so each user loads its own copy (tests render parts alone). */
const ConnectionsContext = createContext<ConnectionInfo[] | null | undefined>(undefined)

/** Null until main has answered; an empty list when it could not. `reload` asks again. */
function useLoadedConnections(skip: boolean): [ConnectionInfo[] | null, () => void] {
  const api = useApi()
  const [list, setList] = useState<ConnectionInfo[] | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => {
    setTick((value) => value + 1)
  }, [])
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
  }, [api, skip, tick])
  return [list, reload]
}

/** Asks main for the connection list again (it changes with the personal-use setting). */
const ReloadContext = createContext<() => void>(() => {})

/** Loads the connection list once for everything below it (one IPC call for the app). */
export function ConnectionsProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [list, reload] = useLoadedConnections(false)
  return (
    <ReloadContext value={reload}>
      <ConnectionsContext value={list}>{children}</ConnectionsContext>
    </ReloadContext>
  )
}

/** The connections main offers, in Settings order: labels and capabilities, never credentials. */
export function useConnections(): ConnectionInfo[] | null {
  const shared = useContext(ConnectionsContext)
  const [own] = useLoadedConnections(shared !== undefined)
  return shared === undefined ? own : shared
}

export function connectionOf(
  list: readonly ConnectionInfo[] | null,
  id: ConnectionId | null | undefined,
): ConnectionInfo | undefined {
  return id ? list?.find((connection) => connection.id === id) : undefined
}

/** One listed connection with what the app knows about its set-up. */
export interface ConnectionRow {
  info: ConnectionInfo
  /** The user has set it up (it is in settings `connections`). */
  configured: boolean
  /** Main's status for a configured connection; null until known or when the check failed. */
  status: ProviderStatus | null
  /** Whether an API-key connection has a saved key; null for the others and while unknown. */
  keySaved: boolean | null
  /** Chats can go to it now. */
  ready: boolean
}

export interface ConnectionOverview {
  /** False until the list and the set-up state have both arrived. */
  loaded: boolean
  rows: ConnectionRow[]
  state: ConnectionsState | null
  /** Reads the state and every configured connection's status again (and the list, if asked). */
  refresh: (options?: { relist?: boolean }) => void
  /** Takes a state main returned (after add, remove or the personal-use toggle). */
  applyState: (state: ConnectionsState) => void
}

const OverviewContext = createContext<ConnectionOverview | undefined>(undefined)

function useLoadedOverview(skip: boolean): ConnectionOverview {
  const api = useApi()
  const list = useConnections()
  const [state, setState] = useState<ConnectionsState | null>(null)
  const [details, setDetails] = useState<
    Record<ConnectionId, { status: ProviderStatus | null; keySaved: boolean | null }>
  >({})
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)
  const reload = useContext(ReloadContext)
  const refresh = useCallback(
    (options?: { relist?: boolean }) => {
      if (options?.relist) reload()
      setTick((value) => value + 1)
    },
    [reload],
  )
  useEffect(() => {
    if (skip || !list) return
    const run = { live: true }
    void (async () => {
      let next: ConnectionsState | null = null
      try {
        next = await api.connections.state()
      } catch (error) {
        console.error('connections.state failed', error)
      }
      const checked = await Promise.all(
        list
          .filter((info) => next?.configured.includes(info.id))
          .map(async (info) => {
            const status = await api.connections.status(info.id).catch(() => null)
            const key =
              info.capabilities.authKind === 'api-key'
                ? await api.apiKey.status(info.id).catch(() => null)
                : null
            return [info.id, { status, keySaved: key ? key.saved : null }] as const
          }),
      )
      if (!run.live) return
      setState(next)
      setDetails(Object.fromEntries(checked))
      setLoaded(true)
    })()
    return () => {
      run.live = false
    }
  }, [api, list, skip, tick])
  const rows = useMemo(
    () =>
      (list ?? []).map((info): ConnectionRow => {
        const configured = state?.configured.includes(info.id) ?? false
        const found = details[info.id]
        const status = found?.status ?? null
        const keySaved = found?.keySaved ?? null
        return {
          info,
          configured,
          status,
          keySaved,
          ready: configured && isReady(info, status, keySaved ?? undefined),
        }
      }),
    [list, state, details],
  )
  return { loaded, rows, state, refresh, applyState: setState }
}

/** Loads the connections' set-up once for the app: the composer, Settings and the wizard share it. */
export function ConnectionOverviewProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const overview = useLoadedOverview(false)
  return <OverviewContext value={overview}>{children}</OverviewContext>
}

export function useConnectionOverview(): ConnectionOverview {
  const shared = useContext(OverviewContext)
  const own = useLoadedOverview(shared !== undefined)
  return shared ?? own
}
