/**
 * How long the wizard waits on main before it stops waiting: closing or going back never hangs on
 * a provider call that does not answer. A switch that lands later is put right in the background.
 */
export const SETTLE_WAIT_MS = 3000

/** True when the promise settled (either way) within `ms`; false when the wait ran out first. */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => {
      done(false)
    }, ms)
  })
  const settled = promise.then(
    () => true as const,
    () => true as const,
  )
  try {
    return await Promise.race([settled, timeout])
  } finally {
    clearTimeout(timer)
  }
}
