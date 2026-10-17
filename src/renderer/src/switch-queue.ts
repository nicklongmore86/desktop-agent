/**
 * The one line every change of connection waits in, so at most one switch is ever in flight:
 * the composer picker, Settings, opening another connection's chat, and the wizard's own
 * switch and undo. A task starts when the one before it has settled, however it ended.
 *
 * `intent` counts the choices the user made themselves (picker, Settings, opening a chat). The
 * wizard compares it before it puts a connection back, so it never overrides a choice made
 * since. If a task never settles, later ones wait behind it: that is the cost of never running
 * two switches at once.
 */
export class SwitchQueue {
  #tail: Promise<unknown> = Promise.resolve()
  #pending = 0
  #intent = 0

  /** A switch is running or waiting. */
  get busy(): boolean {
    return this.#pending > 0
  }

  /** How many choices the user has made so far. */
  get intent(): number {
    return this.#intent
  }

  /** Records a choice the user made themselves; call it as the choice is made. */
  choose(): void {
    this.#intent += 1
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.#pending += 1
    const result = this.#tail.then(task)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result.finally(() => {
      this.#pending -= 1
    })
  }
}
