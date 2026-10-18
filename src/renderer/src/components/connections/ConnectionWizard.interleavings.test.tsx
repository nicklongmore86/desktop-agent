import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderStatus } from '../../../../shared/ipc'
import { BUILTIN_CONNECTION_INFO } from '../../../../shared/connections-fixture'
import { ApiContext } from '../../api'
import { ConnectionOverviewProvider, ConnectionsProvider } from '../../connections'
import { SwitchQueue } from '../../switch-queue'
import { fakeApi } from '../../test/fake-api'
import { setViewport } from '../../test/viewport'
import { ConnectionWizard } from './ConnectionWizard'

/**
 * Every await point of an undo, crossed with each thing that can happen meanwhile (the user
 * chooses a connection, or a newer run for another connection starts). Whatever the order:
 * at most one switch is in flight, a user's choice is never overridden, and a connection is
 * removed only by the undo of the run that added it and only while that undo still owns it.
 */

const ready = (provider: string): ProviderStatus => ({
  provider,
  state: 'ready',
  message: 'Ready.',
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const settle = () => new Promise((done) => setTimeout(done, 120))

type Point = 'queued' | 'read' | 'cancel-login' | 'restore'
type Interference = 'none' | 'user-choice' | 'newer-run'

const POINTS: Point[] = ['queued', 'read', 'cancel-login', 'restore']
const INTERFERENCES: Interference[] = ['none', 'user-choice', 'newer-run']

async function scenario(point: Point, interference: Interference) {
  setViewport(1280)
  const fake = fakeApi({ connections: BUILTIN_CONNECTION_INFO })
  const { api } = fake
  const queue = new SwitchQueue()
  const user = userEvent.setup()

  // Every switch the wizard asks for, with how many were ever running at once.
  const switches: string[] = []
  let running = 0
  let mostRunning = 0
  const restoreGate = deferred<ProviderStatus>()
  const onSwitchProvider = vi.fn(async (id: string): Promise<ProviderStatus> => {
    switches.push(id)
    running += 1
    mostRunning = Math.max(mostRunning, running)
    try {
      if (id === 'anthropic-api' && point === 'restore') return await restoreGate.promise
      return ready(id)
    } finally {
      running -= 1
    }
  })
  const onProvider = vi.fn()
  render(
    <ApiContext value={api}>
      <ConnectionsProvider>
        <ConnectionOverviewProvider>
          <ConnectionWizard
            suspended={false}
            firstRun={false}
            startAt="ollama"
            grants={{ roots: [], loadError: null }}
            onGrants={() => {}}
            onProvider={onProvider}
            queue={queue}
            onSwitchProvider={onSwitchProvider}
            onClose={() => {}}
          />
        </ConnectionOverviewProvider>
      </ConnectionsProvider>
    </ApiContext>,
  )
  await screen.findByRole('dialog', { name: 'Find Ollama' })
  await waitFor(() => {
    expect(onSwitchProvider).toHaveBeenCalledWith('ollama')
  })
  // Run A is done: chats are on Ollama, which it added.
  api.provider.get.mockResolvedValue(ready('ollama'))
  await waitFor(() => {
    expect(api.apiKey.status).toHaveBeenCalledWith('ollama')
  })

  // Hold the point the undo is to be stopped at.
  const gate = deferred<ProviderStatus>()
  const blocker = deferred<undefined>()
  if (point === 'queued') void queue.run(() => blocker.promise)
  if (point === 'read') api.provider.get.mockImplementationOnce(() => gate.promise)
  if (point === 'cancel-login')
    api.provider.cancelLogin.mockImplementationOnce(() => gate.promise.then(() => {}))
  await user.keyboard('{Escape}')
  const waitUntilHeld = async (): Promise<void> => {
    if (point === 'read')
      await waitFor(() => {
        expect(api.provider.get).toHaveBeenCalledTimes(1 + 1 + 1)
      })
    if (point === 'cancel-login')
      await waitFor(() => {
        expect(api.provider.cancelLogin).toHaveBeenCalled()
      })
    if (point === 'restore')
      await waitFor(() => {
        expect(onSwitchProvider).toHaveBeenCalledWith('anthropic-api')
      })
  }
  if (point !== 'queued') await waitUntilHeld()

  // Something happens while the undo is stopped there.
  if (interference === 'user-choice') queue.choose()
  if (interference === 'newer-run') {
    const access = await screen.findByRole('dialog', {
      name: 'How do you want to use Local models?',
    })
    await user.click(within(access).getByRole('button', { name: 'Continue' }))
    const apps = await screen.findByRole('dialog', { name: 'Which one do you use?' })
    await user.click(within(apps).getByRole('button', { name: /^LM Studio/ }))
  }

  // Let the undo go on.
  act(() => {
    blocker.resolve(undefined)
    gate.resolve(ready('ollama'))
    restoreGate.resolve(ready('anthropic-api'))
  })
  await settle()
  return { api, switches, mostRunning: () => mostRunning, onProvider }
}

describe('undo interleavings', () => {
  for (const point of POINTS) {
    for (const interference of INTERFERENCES) {
      it(`stopped at "${point}" with ${interference}`, async () => {
        const run = await scenario(point, interference)
        // Never two switches at once.
        expect(run.mostRunning()).toBeLessThanOrEqual(1)
        const removed = vi.mocked(run.api.connections.remove).mock.calls.map(([id]) => id)
        // Only a connection a run added is ever removed.
        for (const id of removed) expect(['ollama', 'lmstudio']).toContain(id)
        const restoredShown = run.onProvider.mock.calls.some(
          ([status]) => (status as ProviderStatus).provider === 'anthropic-api',
        )
        if (interference === 'none') {
          // Control: the undo goes all the way through.
          expect(run.switches).toEqual(['ollama', 'anthropic-api'])
          expect(removed).toEqual(['ollama'])
          expect(restoredShown).toBe(true)
        } else {
          // A user's choice, or a newer run, is never overridden or cleaned up after.
          expect(removed).toEqual([])
          expect(restoredShown).toBe(false)
          if (point !== 'restore') expect(run.switches).not.toContain('anthropic-api')
        }
      })
    }
  }
})
