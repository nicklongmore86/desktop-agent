import { useEffect, useId, useRef, useState } from 'react'
import type { ApprovalKind, ApprovalPrompt } from '../../../shared/ipc'
import { DiffView } from './DiffView'
import { hasLatin, hasRtl, isSuspicious, SafeLines, SafeText } from './reveal'

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

/**
 * Whether the prompt as a whole has Latin letters. Every part is revealed in
 * that context, so a command made only of look-alikes (`.\рау`) is tokenised
 * like the same word in a Latin path would be.
 */
const latinContextOf = (prompt: ApprovalPrompt): boolean =>
  [prompt.tool, prompt.summary, prompt.detail ?? ''].some(hasLatin)

function Detail({
  prompt,
  latinContext,
}: {
  prompt: ApprovalPrompt
  latinContext: boolean
}): React.JSX.Element | null {
  const { detail, kind } = prompt
  if (detail === null) return null
  if (kind === 'write') return <DiffView diff={detail} latinContext={latinContext} />
  const shell = kind === 'shell' ? parseShellDetail(detail) : null
  if (shell) {
    return (
      <dl className="shell-detail">
        <dt>Shell</dt>
        <dd>
          <code aria-label="Shell">
            <SafeText text={shell.shell} latinContext={latinContext} />
          </code>
        </dd>
        <dt>Working folder</dt>
        <dd>
          <code aria-label="Working folder">
            <SafeText text={shell.cwd} latinContext={latinContext} />
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
            <SafeLines text={shell.command} latinContext={latinContext} />
          </pre>
        </dd>
      </dl>
    )
  }
  return (
    <pre className="scroll-box untrusted-block" tabIndex={0} aria-label="Details" dir="ltr">
      <SafeLines text={detail} latinContext={latinContext} />
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
  const latinContext = latinContextOf(prompt)
  const texts = [prompt.tool, prompt.summary, prompt.detail]
  const suspicious = texts.some((text) => isSuspicious(text, { latinContext }))
  const rtl = texts.some((text) => text !== null && hasRtl(text))

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
            <SafeText text={prompt.tool} latinContext={latinContext} />
          </span>
        </header>
        {suspicious && (
          <p className="approval-warning" role="alert">
            <strong>Warning:</strong> this request contains hidden, control or look-alike characters
            (shown as ⟨…⟩ tokens). They can make a path, command or change look different from what
            will actually run. Deny unless you are sure.
          </p>
        )}
        {rtl && (
          <p className="approval-warning approval-rtl" role="alert">
            <strong>Note:</strong> this request contains right-to-left characters (such as Hebrew or
            Arabic). They are shown in stored order, left to right, exactly as they will run, not as
            those words normally read.
          </p>
        )}
        {/* Only the body scrolls, so the title, warning and buttons always stay on screen. */}
        <div className="approval-body" tabIndex={0} aria-label="Request details">
          <p id={summaryId} className="approval-summary">
            <SafeText text={prompt.summary} latinContext={latinContext} />
          </p>
          <p className="approval-origin">
            {prompt.origin === 'user-terminal'
              ? 'Typed in the command bar. Approve only if you typed or pasted this yourself.'
              : prompt.origin === 'user'
                ? 'Requested from an attachment (Copy into folder). Approve only if you chose this yourself.'
                : 'Requested by the agent.'}
          </p>
          <Detail prompt={prompt} latinContext={latinContext} />
        </div>
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
