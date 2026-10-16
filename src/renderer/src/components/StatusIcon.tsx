/**
 * queued: waiting for the user's approval. denied: the user declined it. error: it failed.
 * 'no result': the run ended without one.
 */
export type ToolStatus = 'queued' | 'running' | 'done' | 'error' | 'denied' | 'no result'

/** A small status glyph, distinct in shape as well as colour. Decorative: the text beside it says it. */
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
      {status === 'queued' && (
        <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2" strokeDasharray="3 3" />
      )}
      {status === 'denied' && (
        <>
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" />
          <path d="M4 12L12 4" fill="none" strokeWidth="2" />
        </>
      )}
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
