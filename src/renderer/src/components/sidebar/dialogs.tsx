import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MAX_PROJECT_NAME, PROJECT_ICONS, type ProjectIcon } from '../../../../shared/ipc-projects'

/** At most 48 characters (whole code points), with an ellipsis when cut. */
const short = (text: string): string => {
  const chars = Array.from(text)
  return chars.length > 48 ? `${chars.slice(0, 47).join('')}…` : text
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled)'

/**
 * A small modal over everything, like the delete confirmation: Escape cancels,
 * Tab stays inside, focus goes back to where it was when it closes. While an
 * approval is open (`suspended`) it is hidden and inert: the approval comes first.
 * Rendered into <body>, so a narrow window's drawer cannot clip it.
 */
function Modal({
  title,
  description,
  role = 'dialog',
  suspended,
  onCancel,
  initialFocus,
  children,
  onSubmit,
}: {
  title: string
  description?: React.ReactNode
  role?: 'dialog' | 'alertdialog'
  suspended: boolean
  onCancel: () => void
  initialFocus: React.RefObject<HTMLElement | null>
  children: React.ReactNode
  onSubmit: () => void
}): React.JSX.Element {
  const titleId = useId()
  const textId = useId()
  const dialog = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (!suspended) initialFocus.current?.focus()
  }, [suspended, initialFocus])
  return createPortal(
    <div className="modal-backdrop" hidden={suspended} inert={suspended}>
      <form
        ref={dialog}
        className="confirm-dialog"
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? textId : undefined}
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key !== 'Tab') return
          const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
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
        <h2 id={titleId}>{title}</h2>
        {description && <div id={textId}>{description}</div>}
        {children}
      </form>
    </div>,
    document.body,
  )
}

/** New project, or rename one: a name and an optional icon. */
export function ProjectDialog({
  initial,
  suspended,
  onCancel,
  onSave,
}: {
  /** Set to rename an existing project. */
  initial?: { name: string; icon: ProjectIcon | null }
  suspended: boolean
  onCancel: () => void
  onSave: (name: string, icon: ProjectIcon | null) => void
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [icon, setIcon] = useState<ProjectIcon | null>(initial?.icon ?? null)
  const input = useRef<HTMLInputElement>(null)
  const iconsLabel = useId()
  const clean = name.trim()
  return (
    <Modal
      title={initial ? 'Rename project' : 'New project'}
      suspended={suspended}
      onCancel={onCancel}
      initialFocus={input}
      onSubmit={() => {
        if (clean) onSave(clean, icon)
      }}
    >
      <label className="dialog-field">
        <span>Name</span>
        <input
          ref={input}
          value={name}
          maxLength={MAX_PROJECT_NAME}
          placeholder="Project name"
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
      </label>
      <div className="dialog-field">
        <span id={iconsLabel}>Icon</span>
        <div className="icon-choices" role="radiogroup" aria-labelledby={iconsLabel}>
          {[null, ...PROJECT_ICONS].map((choice) => (
            <button
              key={choice ?? 'none'}
              type="button"
              role="radio"
              aria-checked={icon === choice}
              aria-label={choice ?? 'No icon'}
              className="icon-choice"
              onClick={() => {
                setIcon(choice)
              }}
            >
              <span aria-hidden="true">{choice ?? '–'}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="approval-actions">
        <button type="button" className="button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button-primary" disabled={!clean}>
          {initial ? 'Save' : 'Create project'}
        </button>
      </div>
    </Modal>
  )
}

/** Asks before something is deleted for good. Cancel has the initial focus. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  suspended,
  onCancel,
  onConfirm,
}: {
  title: string
  children: React.ReactNode
  confirmLabel: string
  suspended: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      title={title}
      role="alertdialog"
      description={children}
      suspended={suspended}
      onCancel={onCancel}
      initialFocus={cancel}
      onSubmit={onConfirm}
    >
      <div className="approval-actions">
        <button ref={cancel} type="button" className="button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button-danger">
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

/**
 * Fork a chat: what is copied, and (for the open chat) how much of it. The
 * copy is a new chat of the same provider; the original is not changed.
 */
export function ForkDialog({
  title,
  prompts,
  suspended,
  onCancel,
  onFork,
}: {
  title: string
  /** The open chat's prompts, to fork from one of them; empty for another chat. */
  prompts: string[]
  suspended: boolean
  onCancel: () => void
  /** `upTo`: how many prompts to keep, or null for all of them. */
  onFork: (upTo: number | null) => void
}): React.JSX.Element {
  const [upTo, setUpTo] = useState<number | null>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      title="Fork chat"
      description={
        <>
          <p>
            Makes a copy of “<bdi className="confirm-title">{title}</bdi>” to continue separately.
            The original chat is not changed.
          </p>
          <p>
            {upTo === null ? 'The copy keeps the full conversation: ' : 'The copy keeps '}
            {upTo === null
              ? 'messages and tool results, as text.'
              : `the first ${String(upTo)} ${upTo === 1 ? 'prompt' : 'prompts'} with their replies and tool results, as text.`}{' '}
            Approvals are not copied, so the copy asks again before it changes anything. Tool
            results can include the contents of files from folders you no longer share.
          </p>
        </>
      }
      suspended={suspended}
      onCancel={onCancel}
      initialFocus={confirm}
      onSubmit={() => {
        onFork(upTo)
      }}
    >
      {prompts.length > 1 && (
        <label className="dialog-field">
          <span>Copy</span>
          <select
            value={upTo ?? ''}
            onChange={(event) => {
              setUpTo(event.target.value === '' ? null : Number(event.target.value))
            }}
          >
            <option value="">The whole conversation</option>
            {prompts.slice(0, -1).map((prompt, index) => (
              <option key={index} value={index + 1}>
                {`Up to prompt ${String(index + 1)}: ${short(prompt)}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="approval-actions">
        <button type="button" className="button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button ref={confirm} type="submit" className="button-primary">
          Fork
        </button>
      </div>
    </Modal>
  )
}
