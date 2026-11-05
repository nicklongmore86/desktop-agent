/** The few app methods the single-instance check needs. */
export interface LockableApp {
  requestSingleInstanceLock: () => boolean
  exit: (code?: number) => void
  setAppUserModelId: (id: string) => void
}

/**
 * The Windows AppUserModelID. It must equal `appId` in electron-builder.yml (a test checks):
 * Windows then shows the app's name on notifications and groups its windows under one
 * taskbar button, which the installed shortcut shares.
 */
export const APP_USER_MODEL_ID = 'com.nicklongmore86.desktopagent'

/**
 * Takes the app's single-instance lock, or ends this process on the spot when another copy
 * holds it. Run it before anything reads or writes the app's data, grants, settings, logs or
 * providers: `app.quit()` is not enough here, because it only asks the app to quit and the
 * rest of the main script, including the ready handler that opens those files, still runs.
 * `app.exit()` before the app is ready ends the process without running any more of it.
 * Returns true when this copy owns the app.
 */
export function claimInstance(app: LockableApp): boolean {
  app.setAppUserModelId(APP_USER_MODEL_ID)
  if (app.requestSingleInstanceLock()) return true
  app.exit(0)
  return false
}

/** The pieces of a window that bringing it to the front needs. */
export interface FocusableWindow {
  isDestroyed: () => boolean
  isMinimized: () => boolean
  isVisible: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
}

/** Brings the window back: restores it if minimized, shows it if hidden, and focuses it. */
export function focusWindow(window: FocusableWindow | null | undefined): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}
