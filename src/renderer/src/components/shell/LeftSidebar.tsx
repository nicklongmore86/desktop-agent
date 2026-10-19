import { Settings } from 'lucide-react'
import type { AppInfo } from '../../../../shared/ipc'
import type { PaneVariant } from './shell-context'

/** The one Settings entry: a gear with an accessible name, in the sidebar footer. */
export function SettingsButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <button
      type="button"
      className="icon-button settings-button"
      aria-label="Settings"
      aria-keyshortcuts="Control+,"
      title="Settings (Ctrl+,)"
      onClick={onOpenSettings}
    >
      <Settings size={18} aria-hidden="true" />
    </button>
  )
}

/**
 * The left sidebar's frame: brand (docked only; a drawer has its own title bar), then
 * `children` (the chats), then the footer with the Settings gear and the version.
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
  return (
    <div className="left-sidebar" data-variant={variant}>
      {variant === 'docked' && (
        <div className="workspace-brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <strong>Desktop Agent</strong>
        </div>
      )}
      {children}
      <div className="sidebar-footer">
        <SettingsButton onOpenSettings={onOpenSettings} />
        <p>Changes require your approval.</p>
        <span className="app-version">{appInfo ? `v${appInfo.version}` : '…'}</span>
      </div>
    </div>
  )
}
