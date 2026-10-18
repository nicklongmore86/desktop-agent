import { useEffect, useId, useRef } from 'react'
import { ManageUsageLink } from './ManageUsageLink'

/**
 * "You’re using your ChatGPT plan": shown once, after the first sign-in with plan use. It
 * follows OpenAI's UI guidance (title, "Got it", Manage usage). Got it and Escape dismiss it. While an approval is open (`suspended`) it is hidden
 * and inert, so the approval always comes first; focus returns to where it came from.
 */
export function PlanNotice({
  suspended,
  onDismiss,
}: {
  suspended: boolean
  onDismiss: () => void
}): React.JSX.Element {
  const titleId = useId()
  const textId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const gotIt = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (!suspended) gotIt.current?.focus()
  }, [suspended])
  return (
    <div className="modal-backdrop" hidden={suspended} inert={suspended}>
      <div
        ref={dialog}
        className="confirm-dialog plan-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onDismiss()
            return
          }
          if (event.key !== 'Tab') return
          const items = [
            ...(dialog.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []),
          ]
          const first = items[0]
          const last = items.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <h2 id={titleId}>You’re using your ChatGPT plan</h2>
        <p id={textId}>
          Eligible requests in this app use the usage included in your ChatGPT plan or credits
          balance. You can review and manage it any time in ChatGPT settings. This app can’t see
          your ChatGPT conversations.
        </p>
        <div className="approval-actions">
          <ManageUsageLink />
          <button ref={gotIt} type="button" className="button-primary" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
