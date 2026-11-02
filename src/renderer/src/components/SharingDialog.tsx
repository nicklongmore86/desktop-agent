import { useEffect, useId, useRef } from 'react'
import type { SharingPrompt } from '../../../shared/ipc'
import { plainText } from '../plain-text'

const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`

/** The attached files that go: earlier prompts' and this message's. */
export function attachedItem(attachments: number, inMessage: number): string | null {
  if (attachments <= 0) return null
  const files = count(attachments, 'attached file', 'attached files')
  if (inMessage <= 0) return `${files} from earlier prompts`
  if (inMessage >= attachments) return `${files} in this message`
  return `${files}, including ${String(inMessage)} in this message`
}

/** What will be sent, as a list: earlier messages, tool output, attachments. */
function includedItems(prompt: SharingPrompt): string[] {
  const { messages, toolOutput, attachments } = prompt.includes
  // Older mains did not send it: their count was earlier prompts' files only.
  const inMessage = Number.isFinite(prompt.includes.attachmentsInMessage)
    ? prompt.includes.attachmentsInMessage
    : 0
  const attached = attachedItem(attachments, inMessage)
  return [
    `${count(messages, 'earlier message', 'earlier messages')} (your prompts and the replies)`,
    ...(toolOutput ? ['File contents and command output the agent read in this chat'] : []),
    ...(attached ? [attached] : []),
  ]
}

/**
 * Asks before an open chat's earlier content goes to another vendor for the first time
 * (main refused the send with 'confirmation_required'). Names what will be sent and where.
 * Cancel has the initial focus; Escape cancels and Tab stays inside. While an approval is
 * open (`suspended`) it is hidden and inert, so the approval always comes first. Every
 * string from main is shown as plain text.
 */
export function SharingDialog({
  prompt,
  suspended,
  onCancel,
  onConfirm,
}: {
  prompt: SharingPrompt
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
  const destination = plainText(prompt.destination)
  const sources = prompt.sources.map(plainText).join(', ')
  const local = prompt.reasons.includes('local-to-cloud')
  return (
    <div className="modal-backdrop" hidden={suspended} inert={suspended}>
      <div
        ref={dialog}
        className="confirm-dialog sharing-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        data-testid="sharing-dialog"
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
        <h2 id={titleId}>
          Send this chat to <bdi>{destination}</bdi>?
        </h2>
        <div id={textId}>
          <p>
            {local ? (
              <>
                Earlier replies in this chat came from a model on this computer (
                <bdi>{sources}</bdi>). Continuing here sends them to{' '}
                <bdi className="sharing-destination">{destination}</bdi>, a cloud service.
              </>
            ) : (
              <>
                Earlier replies in this chat came from <bdi>{sources}</bdi>. Continuing here sends
                them to <bdi className="sharing-destination">{destination}</bdi>.
              </>
            )}{' '}
            Along with your new message, this is sent:
          </p>
          <ul className="sharing-includes">
            {includedItems(prompt).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {prompt.notice && (
            <p className="connection-notice" role="note">
              <strong>{plainText(prompt.notice.title)}.</strong> {plainText(prompt.notice.text)}
            </p>
          )}
          <p>Cancel keeps the chat as it is; you can switch back to another connection.</p>
        </div>
        <div className="approval-actions">
          <button ref={cancel} type="button" className="button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button-primary" onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
