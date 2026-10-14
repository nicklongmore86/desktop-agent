import { Worker } from 'node:worker_threads'

// Runs model-supplied regexes (content regexes and compiled name globs) off
// the main thread. A pathological pattern like (a|aa)+$ can backtrack for
// ages; in a worker it can be stopped by terminate(), which interrupts even
// a regex that is mid-match. The source is plain CommonJS so it runs as an
// eval'd worker without a separate bundle entry.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const patterns = workerData.patterns.map((p) => new RegExp(p.source, p.flags))
parentPort.on('message', (msg) => {
  const re = patterns[msg.pattern]
  const hits = []
  for (let i = 0; i < msg.items.length && hits.length < msg.limit; i++) {
    re.lastIndex = 0
    if (re.test(msg.items[i])) hits.push(i)
  }
  parentPort.postMessage({ id: msg.id, hits })
})
`

export interface PatternSource {
  source: string
  flags: string
}

export type MatchOutcome =
  | { kind: 'ok'; hits: number[] }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string }

interface Reply {
  id: number
  hits: number[]
}

/**
 * A worker holding compiled patterns. `match` tests items against one of
 * them with a hard deadline; on timeout, abort or error the worker is
 * terminated and every later call fails the same way.
 */
export class PatternMatcher {
  private readonly worker: Worker
  private nextId = 0
  private dead: MatchOutcome | null = null
  private settle: ((outcome: MatchOutcome) => void) | null = null

  constructor(patterns: readonly PatternSource[]) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { patterns },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    })
    this.worker.on('error', (error: Error) => {
      this.kill({ kind: 'failed', reason: error.message })
    })
    this.worker.on('exit', () => {
      this.kill({ kind: 'failed', reason: 'pattern worker exited' })
    })
  }

  /** Indexes of `items` matching pattern `pattern`, at most `limit` of them. */
  match(
    pattern: number,
    items: readonly string[],
    limit: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<MatchOutcome> {
    if (this.dead) return Promise.resolve(this.dead)
    if (signal.aborted) return Promise.resolve(this.kill({ kind: 'cancelled' }))
    if (timeoutMs <= 0) return Promise.resolve(this.kill({ kind: 'timeout' }))
    const id = this.nextId++
    return new Promise<MatchOutcome>((resolve) => {
      const onAbort = (): void => {
        this.kill({ kind: 'cancelled' })
      }
      const timer = setTimeout(() => {
        this.kill({ kind: 'timeout' })
      }, timeoutMs)
      const onMessage = (reply: Reply): void => {
        if (reply.id === id) done({ kind: 'ok', hits: reply.hits })
      }
      const done = (outcome: MatchOutcome): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.worker.off('message', onMessage)
        this.settle = null
        resolve(outcome)
      }
      this.settle = done
      signal.addEventListener('abort', onAbort, { once: true })
      this.worker.on('message', onMessage)
      this.worker.postMessage({ id, pattern, items, limit })
    })
  }

  close(): Promise<void> {
    this.kill({ kind: 'failed', reason: 'closed' })
    return Promise.resolve()
  }

  private kill(outcome: MatchOutcome): MatchOutcome {
    if (!this.dead) {
      this.dead = outcome
      void this.worker.terminate()
    }
    this.settle?.(this.dead)
    return this.dead
  }
}
