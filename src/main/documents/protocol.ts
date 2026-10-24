import type { DocumentLimits } from './limits'
import type { DocumentErrorCode, DocumentView, ExtractOptions } from './types'

/**
 * Three processes, two channels. Main never holds a port the worker renderer can post
 * to: the renderer talks only to the broker, a utility process (broker.ts) that checks
 * everything the renderer sends before main sees a copy of it. A hostile renderer can
 * hang or crash the broker, never main, and main kills both.
 *
 *   main  <-- parentPort -->  broker  <-- MessagePort -->  worker renderer
 */

/** The IPC channel that hands the worker page its end of the broker's MessageChannel. */
export const WORKER_PORT_CHANNEL = 'document-worker:port'

export interface ExtractJob {
  type: 'extract'
  id: number
  bytes: Uint8Array
  options: ExtractOptions
  limits: DocumentLimits
}

/** Broker -> worker, and main -> broker for the same two messages. */
export type ToWorker = { type: 'init'; wasm: Uint8Array } | ExtractJob

/** Worker -> broker. Never trusted: see reply.ts. */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'init-failed'; message: string }
  | { type: 'result'; id: number; view: DocumentView }
  | { type: 'error'; id: number; code: DocumentErrorCode; message: string }

/** Main -> broker: the worker's port first, then what to send it. */
export type ToBroker = { type: 'connect' } | ToWorker

/** Broker -> main: checked replies, and why the broker gave up on a worker. */
export type FromBroker =
  | { type: 'connected' }
  | { type: 'ready' }
  | { type: 'init-failed'; message: string }
  | { type: 'result'; id: number; view: DocumentView }
  | { type: 'error'; id: number; code: DocumentErrorCode; message: string }
  | { type: 'violation'; message: string }
