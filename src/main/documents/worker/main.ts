import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import { extractDocument } from '../extract'
import { WORKER_PORT_CHANNEL, type FromWorker, type ToWorker } from '../protocol'
import { DocumentError } from '../types'
import { decodeImage, encodeRaster } from './codec'

/**
 * The document worker page: a hidden, sandboxed window with no Node, no network and a
 * locked-down CSP. It parses one document at a time for the main process, over the
 * MessagePort its preload hands it, whose other end is the broker (broker.ts), not main.
 * Anything a hostile file manages to do stays here or in the broker.
 */

let pdfium: Promise<WrappedPdfiumModule> | null = null

function start(port: MessagePort): void {
  // Copied, not transferred: a MessagePortMain accepts only ports in a transfer list, and
  // a transferred ArrayBuffer breaks its deserialiser (the broker treats that as hostile).
  const send = (message: FromWorker): void => {
    port.postMessage(message)
  }
  port.onmessage = (event: MessageEvent<ToWorker>) => {
    const message = event.data
    if (message.type === 'init') {
      const wasmBinary = message.wasm.buffer.slice(
        message.wasm.byteOffset,
        message.wasm.byteOffset + message.wasm.byteLength,
      )
      pdfium = init({ wasmBinary } as never).then((module) => {
        module.PDFiumExt_Init()
        return module
      })
      pdfium.then(
        () => {
          send({ type: 'ready' })
        },
        (error: unknown) => {
          send({ type: 'init-failed', message: String(error) })
        },
      )
      return
    }
    const { id, bytes, options, limits } = message
    const env = {
      pdfium: () => pdfium ?? Promise.reject(new Error('PDFium was not initialised')),
      encode: encodeRaster,
      decodeImage,
    }
    extractDocument(bytes, options, env, limits).then(
      (view) => {
        send({ type: 'result', id, view })
      },
      (error: unknown) => {
        const known = error instanceof DocumentError
        send({
          type: 'error',
          id,
          code: known ? error.code : 'worker-failed',
          message: known ? error.message : 'The document could not be read.',
        })
      },
    )
  }
  port.start()
}

let started = false
window.addEventListener('message', (event: MessageEvent) => {
  const [port] = event.ports
  if (started || event.source !== window || event.data !== WORKER_PORT_CHANNEL || !port) return
  started = true
  start(port)
})
