export type ToolStatus = 'running' | 'done' | 'error' | 'no result'

/** A small status glyph: spinner (running), check (done), cross (error) or dash. Decorative. */
export function StatusIcon({ status }: { status: ToolStatus }): React.JSX.Element {
  return (
    <svg
      className={`status-icon status-icon-${status.replace(' ', '-')}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      {status === 'running' && (
        <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" strokeDasharray="20 18" />
      )}
      {status === 'done' && (
        <path d="M3.5 8.5l3 3 6-6.5" fill="none" strokeWidth="2" strokeLinecap="round" />
      )}
      {status === 'error' && (
        <path d="M4 4l8 8M12 4l-8 8" fill="none" strokeWidth="2" strokeLinecap="round" />
      )}
      {status === 'no result' && <path d="M4 8h8" fill="none" strokeWidth="2" />}
    </svg>
  )
}
