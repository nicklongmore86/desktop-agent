import { app, BrowserWindow, dialog, Notification, powerMonitor, screen } from 'electron'
import { IpcChannels, type ApprovalPrompt, type ChatEvent, type PushChannel } from '../shared/ipc'
import type { WindowState } from '../shared/window-state'
import { appIconPath } from './app-icon'
import { NOTIFICATION_TEXT, AttentionTracker, shouldAlert, type Alert } from './attention'
import { createCloseGuard, type Activity } from './close-guard'
import { focusWindow } from './instance-lock'
import {
  planWindow,
  trackWindowState,
  type PlannedWindow,
  type WindowStateTracker,
} from './window-state'

export interface WindowBehaviourDeps {
  /** What is running or waiting for an answer, from the chat session. */
  activity: () => Activity
  /** Stops the run, denies approvals and closes watchers: what quitting always did. */
  stopWork: () => Promise<void>
  settings: {
    readonly windowState: WindowState | undefined
    setWindowState: (state: unknown) => Promise<void>
    readonly notifications: boolean
  }
  /** A crash or hang prompt is up: quitting is an answer to it, so no second question. */
  recoveryOpen: () => boolean
}

export interface WindowBehaviour {
  /** Where to open the window, and whether to maximize it, from the saved state. */
  plan: () => PlannedWindow
  /** Wires a new app window: saves its bounds, warns before closing, flashes and notifies. */
  attach: (window: BrowserWindow, planned: PlannedWindow) => void
  /** Call with every main -> renderer push; picks out replies finishing and approvals. */
  onPush: (channel: PushChannel, payload: unknown) => void
  /** For a quit the app itself decided on (fatal error, crash-recovery choice): no question. */
  allowQuit: () => void
  /** A quit or close is really happening, or the system is ending the session. */
  isQuitting: () => boolean
  /** Takes down a showing close warning, as if cancelled, for a crash or hang prompt to replace. */
  dismissWarning: () => void
}

/**
 * The window's behaviour beyond opening it: where it opens (and remembering that), the warning
 * before closing during work, and the notification and taskbar flash when the window is not in
 * front. The decisions live in window-state.ts, close-guard.ts and attention.ts (all unit
 * tested); this wires them to Electron.
 */
export function createWindowBehaviour(deps: WindowBehaviourDeps): WindowBehaviour {
  const attention = new AttentionTracker()
  let window: BrowserWindow | null = null
  let tracker: WindowStateTracker | null = null
  // Set only by a confirmed end (see attach); never by a query, which Windows may cancel.
  let sessionEnding = false
  // Held so a notification is not garbage collected before the user clicks it.
  const live = new Set<Electron.Notification>()

  // Linux and macOS: the OS is shutting down. (Windows has the window events below.)
  powerMonitor.on('shutdown', () => {
    sessionEnding = true
  })

  const guard = createCloseGuard({
    app,
    activity: deps.activity,
    // Not a child of the window, so an approval in it can still be answered meanwhile.
    confirm: async (warning, signal) => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Desktop Agent',
        message: warning.message,
        detail: warning.detail,
        buttons: [...warning.buttons],
        defaultId: warning.defaultId,
        cancelId: warning.cancelId,
        noLink: true,
        signal,
      })
      return response === 1
    },
    stopWork: deps.stopWork,
    flushState: () => tracker?.flush() ?? Promise.resolve(),
    // No prompt while the system ends the session, or while a crash or hang prompt is up, which
    // already offers Quit. A hung page is no reason on its own: the warning is a native dialog
    // that reads main's state, and 'unresponsive' can mean a page that is only busy for a moment.
    skipPrompt: () => sessionEnding || deps.recoveryOpen(),
    onError: (error) => {
      console.error('close guard', error)
    },
  })

  const alert = (kind: Alert): void => {
    const target = window
    if (
      !shouldAlert({
        enabled: deps.settings.notifications,
        windowFocused: target?.isFocused() ?? false,
      })
    )
      return
    try {
      if (target && !target.isDestroyed()) target.flashFrame(true)
      if (!Notification.isSupported()) return
      const text = NOTIFICATION_TEXT[kind]
      const icon = appIconPath()
      const notification = new Notification({
        title: text.title,
        body: text.body,
        ...(icon ? { icon } : {}),
      })
      live.add(notification)
      const release = (): void => {
        live.delete(notification)
      }
      // Clicking only brings the window back. It never answers an approval.
      notification.on('click', () => {
        release()
        focusWindow(window)
      })
      notification.on('close', release)
      notification.on('failed', release)
      notification.show()
    } catch (error) {
      console.error('could not show a notification', error)
    }
  }

  return {
    plan: () =>
      planWindow(
        deps.settings.windowState,
        screen.getAllDisplays().map((display) => display.workArea),
        screen.getPrimaryDisplay().workArea,
      ),
    attach(next, planned) {
      window = next
      if (planned.maximized) next.maximize()
      tracker = trackWindowState(next, {
        save: (state) => deps.settings.setWindowState(state),
        onError: (error) => {
          console.error('could not save the window position', error)
        },
      })
      guard.attach(next)
      next.on('focus', () => {
        next.flashFrame(false)
      })
      // Deliberately no 'query-session-end' handler. Windows can still cancel a queried logoff
      // or shutdown, and nothing tells us when it does, so a query must not make a close skip
      // the warning. A blocking dialog there would hold up a real logoff, and preventDefault
      // would block it outright. 'session-end' cannot be cancelled: only that skips the warning.
      next.on('session-end', () => {
        sessionEnding = true
      })
    },
    onPush(channel, payload) {
      if (channel === IpcChannels.chatEvent) {
        const kind = attention.onChatEvent(payload as ChatEvent)
        if (kind) alert(kind)
      } else if (channel === IpcChannels.approvalRequest) {
        const kind = attention.onApproval(payload as ApprovalPrompt)
        if (kind) alert(kind)
      }
    },
    allowQuit: guard.allowQuit,
    isQuitting: () => sessionEnding || guard.isClosing(),
    dismissWarning: guard.dismissWarning,
  }
}
