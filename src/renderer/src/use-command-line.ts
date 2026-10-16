import { useState } from 'react'

/** Commands kept for Up/Down. In memory only: a command line can hold a secret. */
const MAX_HISTORY = 100

export interface CommandLine {
  draft: string
  setDraft: (text: string) => void
  /** The chosen folder if it is still granted, else the first granted folder, else null. */
  cwd: string | null
  setCwd: (cwd: string) => void
  history: readonly string[]
  /** Records a command that was run (repeats of the last one are kept once). */
  remember: (command: string) => void
}

/** The command bar's own draft, folder and history: apart from the chat composer's draft. */
export function useCommandLine(roots: readonly string[]): CommandLine {
  const [draft, setDraft] = useState('')
  const [chosen, setCwd] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly string[]>([])
  const cwd = chosen !== null && roots.includes(chosen) ? chosen : (roots[0] ?? null)
  const remember = (command: string): void => {
    setHistory((current) =>
      current.at(-1) === command ? current : [...current, command].slice(-MAX_HISTORY),
    )
  }
  return { draft, setDraft, cwd, setCwd, history, remember }
}
