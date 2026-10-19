import { ipcRenderer } from 'electron'
import { WORKER_PORT_CHANNEL } from '../main/documents/protocol'

// The document worker page's preload: it only hands the page its MessagePort, once. The
// page gets no other API; everything else travels over that port.
declare const window: {
  postMessage: (message: unknown, targetOrigin: string, transfer: unknown[]) => void
}

ipcRenderer.once(WORKER_PORT_CHANNEL, (event) => {
  window.postMessage(WORKER_PORT_CHANNEL, '*', event.ports)
})
