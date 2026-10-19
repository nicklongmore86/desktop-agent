import { PanelIcon } from './PanelIcon'
import { useShell, type PaneControl } from './shell-context'

function PanelToggle({
  side,
  pane,
  label,
  shortcut,
}: {
  side: 'left' | 'right'
  pane: PaneControl
  label: string
  shortcut: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="icon-button panel-toggle"
      data-side={side}
      aria-label={label}
      aria-expanded={pane.visible}
      aria-controls={pane.controlsId}
      aria-haspopup={pane.docked ? undefined : 'dialog'}
      aria-keyshortcuts={shortcut}
      title={`${label} (${shortcut.replace('Control', 'Ctrl').replace('BracketLeft', '[').replace('BracketRight', ']')})`}
      onClick={pane.toggle}
    >
      <PanelIcon side={side} />
    </button>
  )
}

/**
 * The chat column's header: the sidebar toggles at either end, the title, and the
 * actions. `actions` is the extension point for other features' header controls
 * (for example the Chat | Command switch). Settings is not here: it is the gear in the sidebar.
 */
export function AppHeader({
  subtitle,
  switching,
  onNewChat,
  actions,
}: {
  subtitle: string
  switching: boolean
  onNewChat: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  const shell = useShell()
  return (
    <header className="app-header">
      <PanelToggle
        side="left"
        pane={shell.left}
        label="Chats sidebar"
        shortcut="Control+Alt+BracketLeft"
      />
      <div className="app-header-title">
        <h1>Workspace chat</h1>
        <span className="header-subtitle">{subtitle}</span>
      </div>
      <nav className="app-nav" aria-label="Header">
        {actions}
        <button
          type="button"
          className="mobile-new"
          aria-label="Start new chat"
          disabled={switching}
          onClick={onNewChat}
        >
          ＋
        </button>
        <PanelToggle
          side="right"
          pane={shell.right}
          label="Workspace panel"
          shortcut="Control+Alt+BracketRight"
        />
      </nav>
    </header>
  )
}
