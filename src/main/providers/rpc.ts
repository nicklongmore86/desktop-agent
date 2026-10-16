import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { subscriptionFailure } from './errors'
import { killRuntime } from './runtime'

export type RpcObject = Record<string, unknown>
export function object(value: unknown): RpcObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid runtime protocol object.')
  return value as RpcObject
}

/** Bounded newline JSON-RPC transport. Handles split UTF-8 and multiple frames per chunk. */
export class RpcPeer {
  private buffer = ''
  private nextId = 0
  private closed = false
  private readonly abort = (): void => {
    this.close(new Error('Runtime cancelled.'))
  }
  private pending = new Map<
    number,
    { resolve: (value: RpcObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  onNotification: (method: string, params: RpcObject) => void = () => {}
  onRequest: (method: string, params: RpcObject) => Promise<RpcObject> = () =>
    Promise.reject(new Error('Unsupported runtime request.'))
  onClose: (error: Error) => void = () => {}
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeout = 15000,
    private readonly signal?: AbortSignal,
  ) {
    signal?.addEventListener('abort', this.abort, { once: true })
    if (signal?.aborted) this.abort()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => {
      this.accept(data)
    })
    child.stderr.resume()
    child.once('error', () => {
      this.close(new Error('Runtime could not start.'))
    })
    child.once('close', () => {
      this.close(new Error('Runtime exited.'))
    })
    child.stdin.on('error', () => {
      this.close(new Error('Runtime input closed.'))
    })
  }
  private write(value: unknown): void {
    if (this.closed) throw new Error('Runtime is closed.')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  notify(method: string, params: RpcObject = {}): void {
    this.write({ method, params })
  }
  request(method: string, params: RpcObject = {}): Promise<RpcObject> {
    if (this.closed) return Promise.reject(new Error('Runtime is closed.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close(new Error('Runtime request timed out.'))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch {
        this.close(new Error('Runtime write failed.'))
      }
    })
  }
  private accept(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.close(new Error('Runtime frame exceeded limit.'))
      return
    }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (!line.trim()) continue
      try {
        const msg = object(JSON.parse(line))
        if (typeof msg['method'] === 'string') {
          const params = object(msg['params'] ?? {})
          if (msg['id'] !== undefined) {
            const id = msg['id']
            if (typeof id !== 'string' && typeof id !== 'number')
              throw new Error('Invalid request id.')
            void this.onRequest(msg['method'], params)
              .then(
                (result) => {
                  if (!this.closed) this.write({ id, result })
                },
                () => {
                  if (!this.closed)
                    this.write({
                      id,
                      error: { code: -32601, message: 'Request denied by Desktop Agent.' },
                    })
                },
              )
              .catch(() => {
                this.close(new Error('Runtime response failed.'))
              })
          } else this.onNotification(msg['method'], params)
        } else {
          const entry = typeof msg['id'] === 'number' ? this.pending.get(msg['id']) : undefined
          if (!entry) throw new Error('Unexpected runtime response.')
          this.pending.delete(msg['id'] as number)
          clearTimeout(entry.timer)
          if (msg['error']) entry.reject(subscriptionFailure(msg['error'], 'codex'))
          else entry.resolve(object(msg['result']))
        }
      } catch {
        this.close(new Error('Invalid runtime protocol.'))
        return
      }
    }
  }
  close(error = new Error('Runtime closed.')): void {
    if (this.closed) return
    this.closed = true
    this.signal?.removeEventListener('abort', this.abort)
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    void killRuntime(this.child)
    this.onClose(error)
  }
}
