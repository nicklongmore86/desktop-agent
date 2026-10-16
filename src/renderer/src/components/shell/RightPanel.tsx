import { useRef } from 'react'
import { RIGHT_TABS, type RightTabId } from '../../../../shared/ipc-layout'
import { RIGHT_TAB_LABELS } from '../../layout'
import { useShell } from './shell-context'

/**
 * The Workspace panel: a tab strip and the selected tab's panel. `tabs` holds one
 * node per tab; later features fill their tab by replacing the node passed in
 * for it (see tabs/FilesTab.tsx and tabs/GitTab.tsx), not by editing this file.
 * The selected tab is saved with the layout.
 */
export function RightPanel({
  tabs,
}: {
  tabs: Record<RightTabId, React.ReactNode>
}): React.JSX.Element {
  const { rightTab, setRightTab } = useShell()
  const buttons = useRef(new Map<RightTabId, HTMLButtonElement>())

  const select = (id: RightTabId): void => {
    setRightTab(id)
    buttons.current.get(id)?.focus()
  }
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const index = RIGHT_TABS.indexOf(rightTab)
    let next: RightTabId | undefined
    if (event.key === 'ArrowRight') next = RIGHT_TABS[(index + 1) % RIGHT_TABS.length]
    else if (event.key === 'ArrowLeft')
      next = RIGHT_TABS[(index + RIGHT_TABS.length - 1) % RIGHT_TABS.length]
    else if (event.key === 'Home') next = RIGHT_TABS[0]
    else if (event.key === 'End') next = RIGHT_TABS.at(-1)
    if (!next) return
    event.preventDefault()
    select(next)
  }

  return (
    <div className="right-panel">
      <div className="right-tabs" role="tablist" aria-label="Workspace" onKeyDown={onKeyDown}>
        {RIGHT_TABS.map((id) => (
          <button
            key={id}
            ref={(element) => {
              if (element) buttons.current.set(id, element)
              else buttons.current.delete(id)
            }}
            type="button"
            role="tab"
            id={`workspace-tab-${id}`}
            aria-selected={rightTab === id}
            aria-controls={`workspace-panel-${id}`}
            tabIndex={rightTab === id ? 0 : -1}
            onClick={() => {
              setRightTab(id)
            }}
          >
            {RIGHT_TAB_LABELS[id]}
          </button>
        ))}
      </div>
      <div
        className="right-tabpanel"
        role="tabpanel"
        id={`workspace-panel-${rightTab}`}
        aria-labelledby={`workspace-tab-${rightTab}`}
        tabIndex={0}
      >
        {tabs[rightTab]}
      </div>
    </div>
  )
}
