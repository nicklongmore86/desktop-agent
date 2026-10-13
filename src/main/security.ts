import type { WebPreferences } from 'electron'

/** webPreferences for every app window: isolated, sandboxed, no Node in the renderer. */
export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    spellcheck: false,
  }
}

/**
 * True when `target` is part of the app itself: the same origin as the dev
 * server, or the same file as the packaged index.html. Everything else is
 * external and must not be loaded in an app window.
 */
export function isAppUrl(target: string, appUrl: string): boolean {
  let to: URL
  let app: URL
  try {
    to = new URL(target)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') {
    return to.protocol === 'file:' && to.pathname === app.pathname
  }
  return to.origin === app.origin
}
