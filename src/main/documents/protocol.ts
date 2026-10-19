import type { DocumentLimits } from './limits'
import type { DocumentErrorCode, DocumentView, ExtractOptions } from './types'

/** The IPC channel that hands the worker page its end of the MessageChannel (via its preload). */
export const WORKER_PORT_CHANNEL = 'document-worker:port'

/** Main -> worker messages over the MessagePort. Bytes travel as copies, never as paths. */
export type ToWorker =
  | { type: 'init'; wasm: Uint8Array }
  | {
      type: 'extract'
      id: number
      bytes: Uint8Array
      options: ExtractOptions
      limits: DocumentLimits
    }

/** Worker -> main messages. The host validates these: the worker parses hostile input. */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'init-failed'; message: string }
  | { type: 'result'; id: number; view: DocumentView }
  | { type: 'error'; id: number; code: DocumentErrorCode; message: string }
