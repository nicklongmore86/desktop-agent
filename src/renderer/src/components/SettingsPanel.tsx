import type {
  ApiKeyStatus,
  AuditStatus,
  GrantsState,
  ProviderStatus,
  ProviderId,
  AppInfo,
} from '../../../shared/ipc'
import type { SettingsSection } from '../open-settings'
import { AccountsSection } from './settings/AccountsSection'
import { FoldersSection } from './settings/FoldersSection'
import { AppearanceSection, PrivacySection, AboutSection } from './settings/OtherSections'
export interface SettingsPanelProps {
  provider?: ProviderStatus | null | undefined
  onProvider?: ((status: ProviderStatus) => void) | undefined
  /** Switches provider; the chat uses it to hide the old conversation meanwhile. */
  onSwitchProvider: (provider: ProviderId) => Promise<ProviderStatus>
  keyStatus: ApiKeyStatus | null
  onKeyStatus: (status: ApiKeyStatus) => void
  grants: GrantsState | null
  onGrants: (grants: GrantsState) => void
  audit: AuditStatus | null
}

export const SETTINGS_SECTIONS = {
  accounts: 'Accounts & providers',
  folders: 'Folders & permissions',
  appearance: 'Appearance',
  privacy: 'Privacy & audit log',
  about: 'About',
} as const
export function SettingsPanel(
  props: SettingsPanelProps & { section?: SettingsSection; appInfo?: AppInfo | null },
): React.JSX.Element {
  const section = props.section
  return (
    <div className="settings" aria-label="Settings">
      {(!section || section === 'accounts') && <AccountsSection {...props} />}
      {(!section || section === 'folders') && (
        <FoldersSection grants={props.grants} onGrants={props.onGrants} />
      )}
      {(!section || section === 'appearance') && <AppearanceSection />}
      {(!section || section === 'privacy') && <PrivacySection audit={props.audit} />}
      {(!section || section === 'about') && <AboutSection appInfo={props.appInfo} />}
    </div>
  )
}
