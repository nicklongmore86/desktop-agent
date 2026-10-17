import { useId, useState } from 'react'
import { MAX_COMMAND_LENGTH } from '../../../shared/ipc-command'
import type { OpenSettings } from '../open-settings'
import { plainTitle } from './reveal'

/** The shell prompt for `cwd`: PowerShell's on Windows, sh's elsewhere. */
export function commandPrompt(cwd: string, platform: string | undefined): string {
  return platform === 'win32' ? `PS ${cwd}>` : `${cwd} $`
}

export interface CommandBarProps {
  draft: string
  onDraft: (text: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  /** The granted folders: the only places a command can run. */
  roots: readonly string[]
  cwd: string | null
  onCwd: (cwd: string) => void
  /** Earlier commands, oldest first, for Up/Down. */
  history: readonly string[]
  platform: string | undefined
  running: boolean
  switching: boolean
  sending: boolean
  onSubmit: () => void
  onStop: () => void
  onOpenSettings: OpenSettings
}

/**
 * The Command view's input: one command line at a time, run in a granted folder after
 * the usual approval. It is not a terminal: no input reaches a running command and
 * nothing interactive runs. Up/Down walk the history; the draft is kept apart from the
 * chat composer's.
 */
export function CommandBar({
  draft,
  onDraft,
  inputRef,
  roots,
  cwd,
  onCwd,
  history,
  platform,
  running,
  switching,
  sending,
  onSubmit,
  onStop,
  onOpenSettings,
}: CommandBarProps): React.JSX.Element {
  const promptId = useId()
  const hintId = useId()
  // Where Up/Down is in the history (history.length = the draft being typed), and that draft.
  const [browsing, setBrowsing] = useState<{ index: number; typed: string } | null>(null)

  if (roots.length === 0 || cwd === null) {
    return (
      <div className="command-bar command-bar-empty" role="note">
        <p>Grant a folder in Settings to run commands in it.</p>
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            onOpenSettings('folders')
          }}
        >
          Open Settings
        </button>
      </div>
    )
  }

  const recall = (step: -1 | 1): boolean => {
    const index = (browsing?.index ?? history.length) + step
    if (index < 0 || index > history.length) return false
    const typed = browsing?.typed ?? draft
    if (index === history.length) {
      setBrowsing(null)
      onDraft(typed)
    } else {
      setBrowsing({ index, typed })
      onDraft(history[index] ?? '')
    }
    return true
  }

  return (
    <form
      className="command-bar"
      aria-label="Command bar"
      onSubmit={(event) => {
        event.preventDefault()
        setBrowsing(null)
        onSubmit()
      }}
    >
      <div className="command-line">
        {/* The prompt is cut short in a narrow window; the tooltip has the whole folder. */}
        <span id={promptId} className="command-prompt" dir="ltr" title={plainTitle(cwd)}>
          {commandPrompt(cwd, platform)}
        </span>
        <input
          ref={inputRef}
          className="command-input"
          type="text"
          aria-label="Command"
          aria-describedby={`${promptId} ${hintId}`}
          placeholder="Type a command…"
          dir="ltr"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={MAX_COMMAND_LENGTH}
          value={draft}
          onChange={(event) => {
            setBrowsing(null)
            onDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey)
              return
            if (event.key === 'ArrowUp' && recall(-1)) event.preventDefault()
            else if (event.key === 'ArrowDown' && recall(1)) event.preventDefault()
          }}
        />
        {running ? (
          <button
            type="button"
            className="composer-send button-danger"
            aria-label="Stop"
            title="Stop (Esc)"
            onClick={onStop}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className="composer-send button-primary"
            aria-label="Run"
            title="Run (Enter)"
            disabled={!draft.trim() || sending || switching}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path
                d="M5 3.5l6 4.5-6 4.5z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="command-bar-footer">
        {roots.length > 1 ? (
          <select
            className="composer-select command-cwd"
            aria-label="Folder"
            value={cwd}
            disabled={running || switching}
            onChange={(event) => {
              onCwd(event.target.value)
            }}
          >
            {roots.map((root) => (
              <option key={root} value={root}>
                {root}
              </option>
            ))}
          </select>
        ) : (
          <span className="command-cwd command-cwd-single" dir="ltr" title={cwd}>
            {cwd}
          </span>
        )}
        <span id={hintId} className="command-hint">
          Enter to run · ↑/↓ history · Esc to stop · You approve every command
        </span>
      </div>
    </form>
  )
}
