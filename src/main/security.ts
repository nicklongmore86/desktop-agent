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
    // Compare the host too: file://server/share/... is a UNC path on Windows.
    return to.protocol === 'file:' && to.hostname === app.hostname && to.pathname === app.pathname
  }
  return to.origin === app.origin
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for plain-http URLs on a loopback host (any port): what the Vite dev server uses. */
export function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * True when an IPC call comes from the app's own top-level frame. Subframes
 * are refused even at an app URL: the app has none, so one is not ours.
 */
export function isTrustedSenderFrame(
  frame: { url: string; parent: unknown } | null | undefined,
  appUrl: string,
): boolean {
  return !!frame && frame.parent === null && isAppUrl(frame.url, appUrl)
}
