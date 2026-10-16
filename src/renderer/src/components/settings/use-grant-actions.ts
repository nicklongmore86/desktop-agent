import { useState } from 'react'
import type { GrantsState } from '../../../../shared/ipc'
import { useApi } from '../../api'

/**
 * Adding and removing granted folders, for Settings and the Workspace panel. Adding
 * opens main's native folder picker (the renderer cannot name a folder); a folder
 * main refuses shows its reason.
 */
export function useGrantActions(onGrants: (grants: GrantsState) => void) {
  const api = useApi()
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await api.grants.add()
      onGrants(result.grants)
      if (result.status === 'refused') setMessage(result.reason)
    } catch {
      setMessage('Could not add the folder.')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (root: string): Promise<void> => {
    try {
      onGrants(await api.grants.remove(root))
    } catch {
      setMessage('Could not remove the folder.')
    }
  }
  return { message, busy, add, remove }
}
