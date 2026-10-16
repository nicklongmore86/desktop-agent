import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import type { FileLocation } from '../../../../shared/ipc-files'
import { useApi } from '../../api'
import { useToast } from '../Toast'

/** Puts reference text into the message box at the caret. */
export type InsertText = (text: string) => void

interface FileReferences {
  /** The composer registers where references go; returns the unregister. */
  register: (target: InsertText) => () => void
  /**
   * Asks main for an entry's reference text (main resolves it through PathGuard and
   * refuses what may not be referenced) and inserts it into the message box.
   */
  insert: (location: FileLocation) => Promise<boolean>
}

const FileReferencesContext = createContext<FileReferences | null>(null)

/** Connects the Files tree (and the `@` menu) to the message box. */
export function FileReferencesProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const api = useApi()
  const notify = useToast()
  const target = useRef<InsertText | null>(null)
  const register = useCallback((next: InsertText) => {
    target.current = next
    return () => {
      if (target.current === next) target.current = null
    }
  }, [])
  const insert = useCallback(
    async (location: FileLocation): Promise<boolean> => {
      let result
      try {
        result = await api.files.reference(location)
      } catch {
        result = { ok: false as const, reason: 'Could not add the reference.' }
      }
      if (!result.ok) {
        notify(result.reason)
        return false
      }
      if (!target.current) {
        notify('Open a chat to add a reference.')
        return false
      }
      target.current(result.text)
      return true
    },
    [api, notify],
  )
  const value = useMemo(() => ({ register, insert }), [register, insert])
  return <FileReferencesContext value={value}>{children}</FileReferencesContext>
}

/** Inserts an entry's reference into the message box (no-op outside the provider). */
export function useInsertFileReference(): FileReferences['insert'] {
  return useContext(FileReferencesContext)?.insert ?? noInsert
}

const noInsert = (): Promise<boolean> => Promise.resolve(false)

/** For the message box: receive references while mounted. */
export function useFileReferenceTarget(target: InsertText): void {
  const context = useContext(FileReferencesContext)
  const latest = useRef(target)
  useEffect(() => {
    latest.current = target
  })
  useEffect(
    () =>
      context?.register((text) => {
        latest.current(text)
      }),
    [context],
  )
}
