import { useState } from 'react'
import type { AppInfo, AuditStatus } from '../../../../shared/ipc'
import { useApi } from '../../api'
import { THEME_LABELS, useTheme } from '../../theme'

export function AppearanceSection(): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  return (
    <section className="settings-section">
      <h3>Appearance</h3>
      <p>Theme</p>
      <div role="group" aria-label="Theme" className="theme-segments">
        {(['system', 'light', 'dark'] as const).map((value) => (
          <button
            key={value}
            aria-pressed={theme === value}
            onClick={() => {
              void setTheme(value)
            }}
          >
            {THEME_LABELS[value]}
          </button>
        ))}
      </div>
    </section>
  )
}
export function PrivacySection({ audit }: { audit: AuditStatus | null }): React.JSX.Element {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="settings-section">
      <h3>Privacy &amp; audit log</h3>
      <p>Every tool call is recorded on this computer.</p>
      <code className="audit-path">{audit?.path ?? '…'}</code>
      <p role="status">
        {audit
          ? audit.healthy
            ? 'Logging is healthy'
            : 'Logging is failing'
          : 'Checking logging…'}
      </p>
      <div className="settings-row">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(audit?.path ?? '').catch(() => {
              setError('Could not copy the path.')
            })
          }}
        >
          Copy path
        </button>
        <button
          onClick={() => {
            void api.audit.reveal().catch(() => {
              setError('Could not show the audit log.')
            })
          }}
        >
          Show in folder
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
export function AboutSection({
  appInfo,
}: {
  appInfo?: AppInfo | null | undefined
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const diagnostics = `Desktop Agent ${appInfo?.version ?? 'unknown'}\nPlatform: ${appInfo?.platform ?? 'unknown'}\n${appInfo?.runtimes?.map((runtime) => `${runtime.name} ${runtime.version}: ${runtime.location ?? 'Unavailable'}`).join('\n') ?? 'Runtime information unavailable'}`
  return (
    <section className="settings-section">
      <h3>About</h3>
      <p>Desktop Agent {appInfo?.version ?? '…'}</p>
      <a
        href="https://github.com/nicklongmore86/desktop-agent#readme"
        target="_blank"
        rel="noreferrer"
      >
        README
      </a>
      <details>
        <summary>Diagnostics</summary>
        <pre>{diagnostics}</pre>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(diagnostics).catch(() => {
              setError('Could not copy diagnostics.')
            })
          }}
        >
          Copy diagnostics
        </button>
        {error && <p role="alert">{error}</p>}
      </details>
    </section>
  )
}
