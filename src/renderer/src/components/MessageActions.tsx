import { copyText } from '../clipboard'
import { useToast } from './Toast'

/** Copy (and optionally Retry) for one message. Shown on hover and whenever focus is inside. */
export function MessageActions({
  text,
  onRetry,
  retryDisabled,
}: {
  text: string
  /** Present only on the message that can be retried. */
  onRetry?: () => void
  retryDisabled?: boolean
}): React.JSX.Element {
  const notify = useToast()
  return (
    <div className="message-actions">
      <button
        type="button"
        aria-label="Copy message"
        title="Copy"
        onClick={() => {
          void copyText(text).then((ok) => {
            notify(ok ? 'Copied' : 'Could not copy')
          })
        }}
      >
        Copy
      </button>
      {onRetry && (
        <button
          type="button"
          aria-label="Retry"
          title={retryDisabled ? 'Retry is available when the reply has finished' : 'Send again'}
          disabled={retryDisabled}
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  )
}
