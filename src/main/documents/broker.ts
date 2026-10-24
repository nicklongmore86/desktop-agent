import type { MessagePortMain } from 'electron'
import { checkReply } from './reply'
import type { ExtractJob, FromBroker, ToBroker, ToWorker } from './protocol'
import { DocumentError } from './types'

/**
 * The document broker: a utility process between main and the worker renderer. It is
 * the only process that deserialises what the renderer posts, so a hostile renderer's
 * message (a transferred ArrayBuffer, a huge payload) hangs or crashes this process,
 * not main. It checks each reply (reply.ts) and forwards only a fresh copy; on anything
 * unexpected it reports a violation and exits, and main kills the worker with it.
 */

const parent = process.parentPort
let worker: MessagePortMain | null = null
let job: ExtractJob | null = null
let initialising = false

const report = (message: FromBroker): void => {
  parent.postMessage(message)
}

function giveUp(message: string): never {
  report({ type: 'violation', message })
  process.exit(1)
}

function fromWorker(raw: unknown): void {
  const type =
    raw !== null && typeof raw === 'object' ? (raw as { type?: unknown }).type : undefined
  if (initialising) {
    initialising = false
    if (type === 'ready') {
      report({ type: 'ready' })
      return
    }
    const message = type === 'init-failed' ? (raw as { message?: unknown }).message : undefined
    report({
      type: 'init-failed',
      message: typeof message === 'string' ? message.slice(0, 500) : 'no reason given',
    })
    return
  }
  const current = job
  if (!current) giveUp('The document reader sent a message nobody asked for.')
  job = null
  try {
    report(checkReply(raw, current))
  } catch (error) {
    giveUp(error instanceof DocumentError ? error.message : 'The document reader sent a bad reply.')
  }
}

parent.on('message', ({ data, ports }: { data: ToBroker; ports: MessagePortMain[] }) => {
  if (data.type === 'connect') {
    const [port] = ports
    if (!port || worker) giveUp('The broker was connected twice.')
    worker = port
    port.on('message', ({ data: raw }: { data: unknown }) => {
      fromWorker(raw)
    })
    port.on('close', () => {
      giveUp('The document reader went away.')
    })
    port.start()
    report({ type: 'connected' })
    return
  }
  if (!worker) giveUp('The broker has no worker.')
  if (data.type === 'init') initialising = true
  else job = data
  const message: ToWorker = data
  worker.postMessage(message)
})
