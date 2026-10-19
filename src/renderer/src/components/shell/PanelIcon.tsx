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
