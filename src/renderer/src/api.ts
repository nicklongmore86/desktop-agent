import { createContext, useContext } from 'react'
import type { DesktopApi } from '../../shared/ipc'

/** The preload API. Components read it from context so tests can pass a fake. */
export const ApiContext = createContext<DesktopApi | null>(null)

export function useApi(): DesktopApi {
  const api = useContext(ApiContext)
  if (!api) throw new Error('ApiContext is not provided')
  return api
}
