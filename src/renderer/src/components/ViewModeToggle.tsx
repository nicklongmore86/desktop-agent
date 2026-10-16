export type ViewMode = 'chat' | 'command'

/** The header's Chat | Command switch. Ctrl/Cmd+Alt+\ does the same (see use-shortcuts.ts). */
export function ViewModeToggle({
  view,
  onChange,
  disabled,
}: {
  view: ViewMode
  onChange: (view: ViewMode) => void
  disabled: boolean
}): React.JSX.Element {
  const option = (mode: ViewMode, label: string, icon: React.JSX.Element): React.JSX.Element => (
    <button
      type="button"
      className="view-mode-option"
      aria-pressed={view === mode}
      aria-label={label}
      aria-keyshortcuts="Control+Alt+Backslash"
      title={`${label} (Ctrl+Alt+\\)`}
      disabled={disabled}
      onClick={() => {
        onChange(mode)
      }}
    >
      {icon}
    </button>
  )
  return (
    <div className="view-mode-toggle" role="group" aria-label="View">
      {option(
        'chat',
        'Chat',
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>,
      )}
      {option(
        'command',
        'Command',
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M3 4.5l3.5 3.5L3 11.5M8 12h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>,
      )}
    </div>
  )
}
