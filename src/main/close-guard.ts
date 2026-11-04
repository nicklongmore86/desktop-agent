/** What is in progress right now, as far as closing the window is concerned. */
export interface Activity {
  /** What holds the send slot: a reply, a typed command or an in-app action; null when idle. */
  run: 'reply' | 'command' | 'action' | null
  /** Approval prompts waiting for an answer. */
  approvals: number
}

export const isIdle = (activity: Activity): boolean =>
  activity.run === null && activity.approvals === 0

export interface CloseWarning {
  message: string
  detail: string
  buttons: readonly [string, string]
  /** Cancel is the default and what Esc or closing the dialog picks. */
  defaultId: 0
  cancelId: 0
}

const WHAT_STOPS = {
  reply: 'a reply that is still being written',
  command: 'a command that is still running',
  action: 'a file action that is still running',
} as const

/**
 * The text of the warning. Fixed wording that only names the kinds of work in progress: never
 * the prompt, the command, a path or an approval's contents.
 */
export function closeWarning(activity: Activity): CloseWarning {
  const stops: string[] = []
  if (activity.approvals > 0)
    stops.push(
      activity.approvals === 1
        ? 'an approval that is waiting for your answer, which will be denied'
        : `${String(activity.approvals)} approvals that are waiting for your answer, which will be denied`,
    )
  if (activity.run) stops.push(WHAT_STOPS[activity.run])
  return {
    message: 'Desktop Agent is still working',
    detail: `If you quit now, this will stop:\n\n${stops.map((line) => `• ${line}`).join('\n')}`,
    buttons: ['Cancel', 'Stop and quit'],
    defaultId: 0,
    cancelId: 0,
  }
}

export interface GuardedWindow {
  on(event: 'close', listener: (event: { preventDefault: () => void }) => void): unknown
  close(): void
  isDestroyed(): boolean
}

export interface GuardedApp {
  prependListener(
    event: 'before-quit',
    listener: (event: { preventDefault: () => void }) => void,
  ): unknown
  quit(): void
}

export interface CloseGuardDeps {
  app: GuardedApp
  activity: () => Activity
  /** Shows the warning; true when the user chose to stop the work and quit. */
  confirm: (warning: CloseWarning) => Promise<boolean>
  /** Stops the run, denies every approval, and closes watchers (what quitting always did). */
  stopWork: () => Promise<void>
  /** Writes pending window state; never rejects. */
  flushState: () => Promise<void>
  /** True while Windows is logging off or shutting down, or after a quit nobody should question. */
  skipPrompt: () => boolean
  /** Longest wait for stopWork and flushState each, so quitting can never hang. */
  timeoutMs?: number
  onError?: (error: unknown) => void
}

export interface CloseGuard {
  attach: (window: GuardedWindow) => void
  /**
   * Lets the next quit and close through without asking, for a quit the app itself decided on
   * (a fatal error, or the user's answer in the crash-recovery dialog).
   */
  allowQuit: () => void
}

/** Resolves when `work` does, or after `ms`, whichever is first; never rejects. */
async function within(work: () => Promise<void>, ms: number, onError?: (e: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  try {
    await Promise.race([Promise.resolve().then(work), timeout])
  } catch (error) {
    onError?.(error)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Asks before the window closes or the app quits while work is in progress, once. Idle: no
 * prompt. While the prompt is up, further close or quit requests are swallowed (so it never
 * shows twice). Confirming stops the work, then quits; the user cannot loop, and nothing can
 * wait forever (stopWork and flushState are time-limited).
 *
 * The window's own close is held for a moment even when idle, so the window state is written
 * before the process can exit.
 */
export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
  const timeoutMs = deps.timeoutMs ?? 5000
  let state: 'open' | 'prompting' | 'closing' = 'open'
  let quitRequested = false
  let window: GuardedWindow | null = null

  /** Closes for real: the state is `closing`, so the close and quit events pass. */
  const proceed = (): void => {
    state = 'closing'
    // A quit asked for from the menu continues as one; a window close ends in
    // window-all-closed, which quits on Windows and Linux.
    if (quitRequested) deps.app.quit()
    else if (window && !window.isDestroyed()) window.close()
  }

  const ask = async (): Promise<void> => {
    state = 'prompting'
    let confirmed = false
    try {
      confirmed = await deps.confirm(closeWarning(deps.activity()))
    } catch (error) {
      deps.onError?.(error)
    }
    if (!confirmed) {
      state = 'open'
      quitRequested = false
      return
    }
    state = 'closing'
    await within(deps.stopWork, timeoutMs, deps.onError)
    await within(deps.flushState, timeoutMs, deps.onError)
    proceed()
  }

  deps.app.prependListener('before-quit', (event) => {
    if (state === 'closing') return
    quitRequested = true
    if (state === 'prompting') {
      event.preventDefault()
      return
    }
    if (isIdle(deps.activity()) || deps.skipPrompt()) {
      // Nothing to ask about: what quitting always did.
      void within(deps.stopWork, timeoutMs, deps.onError)
      return
    }
    event.preventDefault()
    void ask()
  })

  return {
    attach(next) {
      window = next
      state = 'open'
      next.on('close', (event) => {
        if (state === 'closing') return
        if (state === 'prompting') {
          event.preventDefault()
          return
        }
        if (deps.skipPrompt()) {
          // The system is ending the session: there is no time to wait for anything.
          void deps.flushState()
          return
        }
        event.preventDefault()
        if (isIdle(deps.activity())) {
          // Hold the close until the window state is on disk, then close for real.
          state = 'closing'
          void within(deps.flushState, timeoutMs, deps.onError).then(() => {
            if (quitRequested) deps.app.quit()
            else if (!next.isDestroyed()) next.close()
          })
          return
        }
        void ask()
      })
    },
    allowQuit() {
      state = 'closing'
    },
  }
}
