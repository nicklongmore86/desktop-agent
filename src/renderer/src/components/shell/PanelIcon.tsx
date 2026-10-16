/** A window with one side panel marked: the sidebar toggle glyph. Decorative; the button carries the name. */
export function PanelIcon({ side }: { side: 'left' | 'right' }): React.JSX.Element {
  return (
    <svg
      className="panel-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d={side === 'left' ? 'M6.5 3v10' : 'M9.5 3v10'} />
    </svg>
  )
}

export function GearIcon(): React.JSX.Element {
  return (
    <svg
      className="panel-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  )
}
