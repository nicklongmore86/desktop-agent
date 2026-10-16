import type { AppInfo } from '../../../../shared/ipc'
import type { PaneVariant } from './shell-context'

/**
 * The left sidebar's frame: brand, then `children` (the chats), then the footer.
 * In a drawer only the children show: the drawer has its own title bar, and
 * Preferences is in the header.
 */
export function LeftSidebar({
  variant,
  appInfo,
  onOpenSettings,
  children,
}: {
  variant: PaneVariant
  appInfo: AppInfo | null
  onOpenSettings: () => void
  children: React.ReactNode
}): React.JSX.Element {
  if (variant === 'drawer') return <div className="left-sidebar">{children}</div>
  return (
    <div className="left-sidebar">
      <div className="workspace-brand">
        <span className="brand-mark" aria-hidden="true">
          D
        </span>
        <strong>Desktop Agent</strong>
      </div>
      {children}
      <div className="sidebar-footer">
        <p>Changes require your approval.</p>
        <button type="button" onClick={onOpenSettings}>
          Settings
        </button>
        <span className="app-version">{appInfo ? `v${appInfo.version}` : '…'}</span>
      </div>
    </div>
  )
}
