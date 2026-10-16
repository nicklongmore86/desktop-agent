import { useEffect, useRef, useState } from 'react'
import type { AppInfo } from '../../../shared/ipc'
import {
  SettingsPanel,
  SETTINGS_SECTIONS,
  type SettingsPanelProps,
  type SettingsSection,
} from './SettingsPanel'

export function SettingsDialog(
  props: SettingsPanelProps & {
    initialSection: SettingsSection
    onClose: () => void
    appInfo: AppInfo | null
  },
): React.JSX.Element {
  const [section, setSection] = useState(props.initialSection)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 540px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 540px)')
    const update = () => {
      setNarrow(media.matches)
    }
    media.addEventListener('change', update)
    return () => {
      media.removeEventListener('change', update)
    }
  }, [])
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.focus()
    element?.querySelector(`#settings-${props.initialSection}`)?.scrollIntoView({ block: 'start' })
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !element?.contains(event.target)) element?.focus()
    }
    document.addEventListener('focusin', focus)
    return () => {
      document.removeEventListener('focusin', focus)
      previous?.focus()
    }
  }, [props.initialSection])
  return (
    <div className="settings-overlay">
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="settings-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            props.onClose()
          }
          if (event.key === 'Tab') {
            const items = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary',
              ) ?? [],
            ).filter(
              (item) =>
                item.checkVisibility() &&
                (!item.closest('details:not([open])') || item.tagName === 'SUMMARY'),
            )
            const first = items[0]
            const last = items.at(-1)
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog.current)
            ) {
              event.preventDefault()
              last?.focus()
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === dialog.current)
            ) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <header className="settings-dialog-header">
          <h2 id="settings-title">Settings</h2>
          <button aria-label="Close settings" onClick={props.onClose}>
            ×
          </button>
        </header>
        <div className="settings-dialog-body">
          <nav aria-label="Settings sections">
            {Object.entries(SETTINGS_SECTIONS).map(([id, label]) => (
              <button
                key={id}
                aria-current={section === id ? 'page' : undefined}
                onClick={() => {
                  setSection(id as SettingsSection)
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-pages">
            {(Object.keys(SETTINGS_SECTIONS) as SettingsSection[])
              .filter((id) => narrow || id === section)
              .map((id) => (
                <div
                  key={id}
                  className="settings-page"
                  data-active={section === id}
                  id={`settings-${id}`}
                >
                  <SettingsPanel {...props} section={id} />
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
