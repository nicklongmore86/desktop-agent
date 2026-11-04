import type { ApprovalPrompt, ChatEvent } from '../shared/ipc'

/** The three things worth pulling the user back to the window for. */
export type Alert = 'reply-ready' | 'reply-failed' | 'approval'

/**
 * The text of every notification. Fixed: a notification shows on the lock screen and stays in
 * Windows' notification history, so it never carries a prompt, reply text, file name, path,
 * command or tool argument. The decision code below never even receives them.
 */
export const NOTIFICATION_TEXT: Readonly<Record<Alert, { title: string; body: string }>> = {
  'reply-ready': { title: 'Desktop Agent', body: 'Your reply is ready.' },
  'reply-failed': { title: 'Desktop Agent', body: 'A reply could not be completed.' },
  approval: { title: 'Desktop Agent', body: 'An approval is waiting for your answer.' },
}

/** Stop reasons that mean the user (or the app) cancelled the run: nothing to announce. */
const CANCELLED = new Set(['aborted'])

/** Remembered ids are only needed until their run or approval ends; this bounds a leak. */
const MAX_REMEMBERED = 500

function remember(set: Set<string>, id: string): void {
  set.add(id)
  if (set.size > MAX_REMEMBERED) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
}

/**
 * Turns the chat's event stream and approval prompts into at most one alert each: one per reply
 * (finished, or failed, never both) and one per approval id. Typed commands never alert (the
 * user is watching those run), a stopped run never alerts, and the order of an error followed
 * by run_finished is handled. It does not know about focus or settings: the caller decides
 * whether to show what it returns.
 */
export class AttentionTracker {
  private readonly commands = new Set<string>()
  private readonly failed = new Set<string>()
  private readonly approvals = new Set<string>()

  onChatEvent(event: ChatEvent): Alert | null {
    switch (event.type) {
      case 'command_started':
        remember(this.commands, event.runId)
        return null
      case 'error':
        if (this.commands.has(event.runId) || this.failed.has(event.runId)) return null
        if (CANCELLED.has(event.code)) return null
        remember(this.failed, event.runId)
        return 'reply-failed'
      case 'run_finished': {
        const { runId, stopReason } = event
        if (this.commands.delete(runId)) return null
        if (this.failed.delete(runId)) return null
        if (CANCELLED.has(stopReason)) return null
        return stopReason === 'internal' || ERROR_STOP_REASONS.has(stopReason)
          ? 'reply-failed'
          : 'reply-ready'
      }
      case 'approval_closed':
        this.approvals.delete(event.approvalId)
        return null
      default:
        return null
    }
  }

  /** An approval prompt was sent to the window. Only its id is read. */
  onApproval(prompt: Pick<ApprovalPrompt, 'id'>): Alert | null {
    if (this.approvals.has(prompt.id)) return null
    remember(this.approvals, prompt.id)
    return 'approval'
  }
}

/** Stop reasons that are failures. The agent reports these through an error event first. */
const ERROR_STOP_REASONS = new Set([
  'usage_limit',
  'plan_not_entitled',
  'model_unavailable',
  'auth_expired',
  'runtime_unavailable',
  'authentication',
  'invalid_request',
  'permission',
  'rate_limit',
  'overloaded',
  'network',
  'api',
  'context_too_long',
  'protocol',
  'error',
])

export interface AlertContext {
  /** Settings > Notifications. */
  enabled: boolean
  /** The app window is the one the user is looking at. */
  windowFocused: boolean
}

/** Whether an alert should be shown at all. */
export const shouldAlert = (context: AlertContext): boolean =>
  context.enabled && !context.windowFocused
