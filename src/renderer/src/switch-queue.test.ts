import { describe, expect, it } from 'vitest'
import { SwitchQueue } from './switch-queue'

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise((done) => setTimeout(done, 0))

describe('SwitchQueue', () => {
  it('runs one task at a time, in order', async () => {
    const queue = new SwitchQueue()
    const log: string[] = []
    const first = deferred()
    const a = queue.run(async () => {
      log.push('a start')
      await first.promise
      log.push('a end')
    })
    const b = queue.run(() => {
      log.push('b start')
      return Promise.resolve()
    })
    await tick()
    expect(log).toEqual(['a start'])
    expect(queue.busy).toBe(true)
    first.resolve()
    await Promise.all([a, b])
    expect(log).toEqual(['a start', 'a end', 'b start'])
    expect(queue.busy).toBe(false)
  })

  it('starts the next task after a failure, and passes the failure on', async () => {
    const queue = new SwitchQueue()
    const failing = queue.run(() => Promise.reject(new Error('no')))
    const next = queue.run(() => Promise.resolve('ok'))
    await expect(failing).rejects.toThrow('no')
    await expect(next).resolves.toBe('ok')
  })

  it('keeps later tasks waiting behind one that never settles', async () => {
    const queue = new SwitchQueue()
    void queue.run(() => new Promise<void>(() => {}))
    let started = false
    void queue.run(() => {
      started = true
      return Promise.resolve()
    })
    await tick()
    await tick()
    expect(started).toBe(false)
    expect(queue.busy).toBe(true)
  })

  it('counts the user’s own choices', () => {
    const queue = new SwitchQueue()
    expect(queue.intent).toBe(0)
    queue.choose()
    queue.choose()
    expect(queue.intent).toBe(2)
  })
})
