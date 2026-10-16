import { useEffect, useId, useRef } from 'react'

/**
 * Asks before a chat is deleted. Cancel has the initial focus, Escape
 * cancels and Tab stays inside. While an approval is open (`suspended`) it is
 * hidden and inert, so the approval always comes first; focus returns to it
 * afterwards, and to where it came from once it closes.
 */
export function ConfirmDeleteDialog({
  title,
  suspended,
  onCancel,
  onConfirm,
}: {
  title: string
  suspended: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const titleId = useId()
  const textId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (!suspended) cancel.current?.focus()
  }, [suspended])
  return (
    <div className="modal-backdrop" hidden={suspended} inert={suspended}>
      <div
        ref={dialog}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key !== 'Tab') return
          const buttons = [...(dialog.current?.querySelectorAll<HTMLElement>('button') ?? [])]
          const first = buttons[0]
          const last = buttons.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <h2 id={titleId}>Delete chat?</h2>
        <p id={textId}>
          “<bdi className="confirm-title">{title}</bdi>” will be deleted from this computer. This
          can’t be undone.
        </p>
        <div className="approval-actions">
          <button ref={cancel} type="button" className="button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button-danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
