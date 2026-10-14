import { useEffect, useId, useRef, useState } from 'react'
import type { ApprovalKind, ApprovalPrompt } from '../../../shared/ipc'
import { DiffView } from './DiffView'
import { isSuspicious, SafeLines, SafeText } from './reveal'

const KIND_LABELS: Record<ApprovalKind, string> = {
  write: 'Write a file',
  move: 'Move or rename',
  delete: 'Move to the Recycle Bin',
  shell: 'Run a shell command',
}

/** run_shell's detail: `cwd: …\nshell: …\n\n<command>` (see src/main/tools/run-shell.ts). */
export function parseShellDetail(
  detail: string,
): { cwd: string; shell: string; command: string } | null {
  const match = /^cwd: ([^\n]*)\nshell: ([^\n]*)\n\n([\s\S]*)$/.exec(detail)
  if (!match) return null
  const [, cwd = '', shell = '', command = ''] = match
  return { cwd, shell, command }
}

function Detail({ prompt }: { prompt: ApprovalPrompt }): React.JSX.Element | null {
  const { detail, kind } = prompt
  if (detail === null) return null
  if (kind === 'write') return <DiffView diff={detail} />
  const shell = kind === 'shell' ? parseShellDetail(detail) : null
  if (shell) {
    return (
      <dl className="shell-detail">
        <dt>Shell</dt>
        <dd>
          <code aria-label="Shell">
            <SafeText text={shell.shell} />
          </code>
        </dd>
        <dt>Working folder</dt>
        <dd>
          <code aria-label="Working folder">
            <SafeText text={shell.cwd} />
          </code>
        </dd>
        <dt>Command (exactly as it will run)</dt>
        <dd>
          <pre
            className="command scroll-box untrusted-block"
            tabIndex={0}
            aria-label="Command"
            dir="ltr"
          >
            <SafeLines text={shell.command} />
          </pre>
        </dd>
      </dl>
    )
  }
  return (
    <pre className="scroll-box untrusted-block" tabIndex={0} aria-label="Details" dir="ltr">
      <SafeLines text={detail} />
    </pre>
  )
}

export interface ApprovalCardProps {
  prompt: ApprovalPrompt
  /** How many more prompts wait behind this one. */
  queued: number
  onRespond: (id: string, approved: boolean) => Promise<void>
}

/**
 * A modal approval prompt. Deny has the initial focus, Escape denies, and
 * Tab stays inside the dialog. Each answer quotes the prompt's id.
 */
export function ApprovalCard({ prompt, queued, onRespond }: ApprovalCardProps): React.JSX.Element {
  const titleId = useId()
  const summaryId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const deny = useRef<HTMLButtonElement>(null)
  const [answering, setAnswering] = useState(false)
  const suspicious = [prompt.tool, prompt.summary, prompt.detail].some(isSuspicious)

  // The app keys this card by prompt id, so each prompt mounts afresh with Deny focused.
  useEffect(() => {
    deny.current?.focus()
  }, [])

  const answer = (approved: boolean): void => {
    if (answering) return
    setAnswering(true)
    onRespond(prompt.id, approved).catch(() => {
      setAnswering(false)
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      answer(false)
      return
    }
    if (event.key !== 'Tab' || !dialog.current) return
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'),
    ]
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialog}
        className={`approval approval-${prompt.kind}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        onKeyDown={onKeyDown}
      >
        <header className="approval-header">
          <h2 id={titleId}>Approve: {KIND_LABELS[prompt.kind]}?</h2>
          <span className="approval-tool">
            <SafeText text={prompt.tool} />
          </span>
        </header>
        {suspicious && (
          <p className="approval-warning" role="alert">
            <strong>Warning:</strong> this request contains hidden or control characters (shown as
            ⟨…⟩ tokens). They can make a path, command or change look different from what will
            actually run. Deny unless you are sure.
          </p>
        )}
        <p id={summaryId} className="approval-summary">
          <SafeText text={prompt.summary} />
        </p>
        <Detail prompt={prompt} />
        {queued > 0 && (
          <p className="approval-queue">
            {queued} more request{queued === 1 ? '' : 's'} waiting.
          </p>
        )}
        <div className="approval-actions">
          <button
            ref={deny}
            type="button"
            className="button-secondary"
            disabled={answering}
            onClick={() => {
              answer(false)
            }}
          >
            Deny
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={answering}
            onClick={() => {
              answer(true)
            }}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
