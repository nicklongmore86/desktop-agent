import { createContext, useContext } from 'react'
import type { RightTabId } from '../../../../shared/ipc-layout'

/** How a pane is shown: beside the chat, or as a modal drawer over it. */
export type PaneVariant = 'docked' | 'drawer'

export interface PaneControl {
  /** The pane can be docked in this window; otherwise its toggle opens a drawer. */
  docked: boolean
  /** Showing now, docked or as a drawer. */
  visible: boolean
  toggle: () => void
  /** The id of the element the toggle controls, while it is in the page. */
  controlsId: string | undefined
}

export interface ShellContextValue {
  left: PaneControl
  right: PaneControl
  rightTab: RightTabId
  setRightTab: (tab: RightTabId) => void
  /** Closes the open drawer, if any (choosing a chat or starting a new one does this). */
  closeDrawer: () => void
}

export const ShellContext = createContext<ShellContextValue | null>(null)

/** The shell's panes and toggles, for anything rendered inside <AppShell>. */
export function useShell(): ShellContextValue {
  const shell = useContext(ShellContext)
  if (!shell) throw new Error('ShellContext is not provided')
  return shell
}
