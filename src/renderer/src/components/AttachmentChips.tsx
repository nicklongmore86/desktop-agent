import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentRef,
} from '../../../shared/attachments'
import { ATTACHMENT_UNAVAILABLE } from '../../../shared/ipc'
import {
  canReceive,
  formatSize,
  middleTruncate,
  notReceivedNote,
  totalBytes,
  type StagedAttachment,
} from '../attachments/model'
import { thumbnailFor } from '../attachments/thumbnails'
import { useHeicSupport } from '../attachments/use-heic'

function KindIcon({ kind }: { kind: AttachmentKind }): React.JSX.Element {
  const common = {
    viewBox: '0 0 16 16',
    width: 16,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  }
  if (kind === 'image')
    return (
      <svg {...common}>
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <circle cx="6" cy="7" r="1" />
        <path d="M2.5 12l3.5-3.5 3 3 2-2 2.5 2.5" />
      </svg>
    )
  if (kind === 'pdf')
    return (
      <svg {...common}>
        <path d="M4 2h5l3 3v9H4z" />
        <path d="M9 2v3h3" />
      </svg>
    )
  return (
    <svg {...common}>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3M6 8h4M6 11h4" />
    </svg>
  )
}

interface ChipProps {
  attachment: AttachmentRef
  /** False: the stored file is gone. */
  available?: boolean
  /** The connection cannot receive this kind yet. */
  unsupported?: boolean
  /** Why not, for the tooltip (the kind's general note by default). */
  unsupportedNote?: string | undefined
  /** Staged chips only. */
  onRemove?: () => void
  /** A snapshot from outside the granted folders: offers to copy it into one. */
  onCopyIntoFolder?: () => void
}

/** One attached file: kind icon (or an image's preview), name, size. Read-only without `onRemove`. */
export function AttachmentChip({
  attachment,
  available = true,
  unsupported = false,
  unsupportedNote,
  onRemove,
  onCopyIntoFolder,
}: ChipProps): React.JSX.Element {
  const preview = available && attachment.kind === 'image' ? thumbnailFor(attachment.id) : undefined
  const note = !available
    ? ATTACHMENT_UNAVAILABLE
    : unsupported
      ? (unsupportedNote ?? notReceivedNote(attachment.kind))
      : undefined
  const size = formatSize(attachment.size)
  return (
    <li
      className={`attachment-chip${note ? ' attachment-chip-muted' : ''}`}
      title={note ? `${attachment.name}\n${note}` : attachment.name}
      data-kind={attachment.kind}
    >
      <span className="attachment-chip-icon">
        {preview ? (
          <img className="attachment-chip-thumb" src={preview} alt="" width={28} height={28} />
        ) : (
          <KindIcon kind={attachment.kind} />
        )}
      </span>
      <span className="attachment-chip-text">
        <bdi className="attachment-chip-name" dir="auto">
          {middleTruncate(attachment.name)}
        </bdi>
        <span className="attachment-chip-meta">
          {available ? size : ATTACHMENT_UNAVAILABLE}
          {available && unsupported ? ' · name only' : ''}
        </span>
      </span>
      {onCopyIntoFolder && (
        <button
          type="button"
          className="link-button attachment-chip-copy"
          onClick={onCopyIntoFolder}
        >
          Copy into folder…
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          className="attachment-chip-remove"
          aria-label={`Remove ${attachment.name}`}
          title="Remove"
          onClick={onRemove}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </li>
  )
}

/** The chips above the composer's text box, with a count once a message nears its limits. */
export function StagedChips({
  staged,
  vision,
  onRemove,
  onCopyIntoFolder,
}: {
  staged: readonly StagedAttachment[]
  /** The connection's model can see images (main's word; false until known). */
  vision: boolean
  onRemove: (id: string) => void
  onCopyIntoFolder: (id: string) => void
}): React.JSX.Element | null {
  const heic = useHeicSupport()
  if (staged.length === 0) return null
  const nearLimit =
    staged.length >= ATTACHMENT_LIMITS.maxPerMessage - 2 ||
    totalBytes(staged) >= ATTACHMENT_LIMITS.messageBytes * 0.8
  return (
    <div className="attachment-staged">
      <ul className="attachment-chips" aria-label="Attached files">
        {staged.map(({ attachment, outsideGrant }) => (
          <AttachmentChip
            key={attachment.id}
            attachment={attachment}
            unsupported={!canReceive(attachment.kind, vision, attachment.mime, heic)}
            unsupportedNote={notReceivedNote(attachment.kind, vision, attachment.mime, heic)}
            onRemove={() => {
              onRemove(attachment.id)
            }}
            {...(outsideGrant
              ? {
                  onCopyIntoFolder: () => {
                    onCopyIntoFolder(attachment.id)
                  },
                }
              : {})}
          />
        ))}
      </ul>
      {nearLimit && (
        <p className="attachment-count" role="status">
          {staged.length} of {ATTACHMENT_LIMITS.maxPerMessage} files ·{' '}
          {formatSize(totalBytes(staged))} of {ATTACHMENT_LIMITS.messageBytes / (1024 * 1024)} MB
        </p>
      )}
    </div>
  )
}
