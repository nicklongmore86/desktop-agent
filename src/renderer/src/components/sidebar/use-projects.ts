import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectsState } from '../../../../shared/ipc-projects'
import { useApi } from '../../api'

/**
 * The projects and other providers' organised chats, from main. Loaded once,
 * then again whenever another conversation or provider opens or the open
 * provider's list changes; every action answers with the new state too. Only
 * the newest answer is kept, so a slow one cannot undo a later one.
 */
export function useProjects(): {
  state: ProjectsState | null
  /** Runs a change and shows its answer; resolves false (after `onError`) when it failed. */
  run: <T extends ProjectsState | { state: ProjectsState }>(
    change: () => Promise<T>,
  ) => Promise<T | null>
  error: string | null
  setError: (error: string | null) => void
} {
  const api = useApi()
  const [state, setState] = useState<ProjectsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  const accept = useCallback((next: ProjectsState, ticket: number): void => {
    if (ticket >= latest.current) {
      latest.current = ticket
      setState(next)
    }
  }, [])
  const ticket = useRef(0)
  const refresh = useCallback(() => {
    ticket.current += 1
    const mine = ticket.current
    api.projects.state().then(
      (next) => {
        accept(next, mine)
      },
      (failure: unknown) => {
        console.error('projects.state failed', failure)
      },
    )
  }, [api, accept])

  useEffect(() => {
    refresh()
    return api.onChatEvent((event) => {
      if (event.type === 'conversation_reset' || event.type === 'history_changed') refresh()
    })
  }, [api, refresh])

  const run = useCallback(
    async <T extends ProjectsState | { state: ProjectsState }>(
      change: () => Promise<T>,
    ): Promise<T | null> => {
      ticket.current += 1
      const mine = ticket.current
      try {
        const result = await change()
        accept('state' in result ? result.state : result, mine)
        setError(null)
        return result
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : ''
        // Electron prefixes handler errors; keep only the message written for people.
        setError(
          message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') ||
            'That did not work.',
        )
        refresh()
        return null
      }
    },
    [accept, refresh],
  )

  return { state, run, error, setError }
}
