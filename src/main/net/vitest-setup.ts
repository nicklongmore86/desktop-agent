// Unit tests run outside Electron, so they install a transport over Node's fetch here. Vitest
// loads this file (vitest.config.ts); no app code imports it, so the app has no such fallback.
import { installNetworkTransports, type Transport } from './network'

/** Behaves as Electron's Session.fetch does for redirect: 'error': it rejects, with its wording. */
const overNodeFetch: Transport = async (url, init) => {
  // Looked up per call, so tests can stub the global fetch.
  const response = await globalThis.fetch(url, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    throw new Error("Attempted to redirect, but redirect policy was 'error'")
  }
  return response
}

installNetworkTransports({ cloud: overNodeFetch, local: overNodeFetch })
