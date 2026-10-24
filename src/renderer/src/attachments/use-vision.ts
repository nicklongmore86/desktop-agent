import { useEffect, useState } from 'react'
import type { ConnectionId, ConnectionVision } from '../../../shared/ipc-connections'
import { useApi } from '../api'

/** Fired on window after "This model can see images" changes, so the composer asks again. */
export const VISION_CHANGED = 'desktop-agent:vision-changed'

/**
 * Whether images reach `connection`'s current model, as main decides it. Asked again when
 * the connection or `model` changes, and after the setting changes. Null until known;
 * anything that fails reads as no vision.
 */
export function useConnectionVision(
  connection: ConnectionId | null | undefined,
  model?: string | null,
): ConnectionVision | null {
  const api = useApi()
  const [vision, setVision] = useState<{ key: string; value: ConnectionVision } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const changed = (): void => {
      setTick((value) => value + 1)
    }
    window.addEventListener(VISION_CHANGED, changed)
    return () => {
      window.removeEventListener(VISION_CHANGED, changed)
    }
  }, [])
  const key = `${connection ?? ''}\n${model ?? ''}`
  useEffect(() => {
    if (!connection) return
    let current = true
    api.connections.vision(connection).then(
      (value) => {
        if (current) setVision({ key, value })
      },
      () => {
        if (current)
          setVision({
            key,
            value: { enabled: false, source: 'connection', setting: false, configurable: false },
          })
      },
    )
    return () => {
      current = false
    }
  }, [api, connection, key, tick])
  return vision?.key === key ? vision.value : null
}
