import { app, session } from 'electron'
import type { NetworkTransports } from './network'

/**
 * Two in-memory sessions of their own, so these requests never share the default session's
 * cookies or cache. Electron throws before the app is ready: call this from whenReady.
 *
 * No request here has a `login` listener, so Electron cancels an authentication challenge
 * rather than showing a dialog. Chromium still answers a proxy with the Windows sign-in
 * (NTLM, Negotiate) on its own, as a browser does.
 */
export async function createElectronTransports(): Promise<NetworkTransports> {
  const cloud = session.fromPartition('network-cloud', { cache: false })
  const local = session.fromPartition('network-local', { cache: false })
  // Not Chromium's browser string, which some providers' bot checks treat differently.
  const userAgent = `DesktopAgent/${app.getVersion()}`
  cloud.setUserAgent(userAgent)
  local.setUserAgent(userAgent)
  await cloud.setProxy({ mode: 'system' })
  // Chromium skips the proxy for loopback only by default: a system bypass list containing
  // <-loopback> turns that off, and Node's fetch honours NODE_USE_ENV_PROXY. Direct is direct.
  await local.setProxy({ mode: 'direct' })
  return {
    cloud: (url, init) => cloud.fetch(url, init),
    local: (url, init) => local.fetch(url, init),
  }
}
