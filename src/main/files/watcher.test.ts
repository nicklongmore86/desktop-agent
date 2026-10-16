import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileLocation, FilesChanged } from '../../shared/ipc-files'
import { PathGuard } from '../permissions/guard'
import { makeSandbox, put } from '../permissions/test-support'
import { rootId } from './location'
import { createFilesService } from './service'
import { FolderWatcher, type WatchFolder } from './watcher'

/** A fake fs.watch: records open watchers and lets the test fire their events. */
function fakeWatch() {
  const open = new Map<string, { change: () => void; error: (e: unknown) => void }>()
  const closed: string[] = []
  const watch: WatchFolder = (p, change, error) => {
    open.set(p, { change, error })
    return {
      close: () => {
        open.delete(p)
        closed.push(p)
      },
    }
  }
  return { watch, open, closed }
}

const A: FileLocation = { rootId: 'rA', rel: '' }
const B: FileLocation = { rootId: 'rA', rel: 'src' }
const OTHER: FileLocation = { rootId: 'rB', rel: '' }

function setup(options: { refuse?: string[] } = {}) {
  vi.useFakeTimers()
  const granted = new Set(['rA', 'rB'])
  const events: FilesChanged[] = []
  const fake = fakeWatch()
  const watcher = new FolderWatcher({
    resolve: (location) =>
      Promise.resolve(
        options.refuse?.includes(location.rel) ? null : `/${location.rootId}/${location.rel}`,
      ),
    isGranted: (id) => granted.has(id),
    emit: (change) => events.push(change),
    watch: fake.watch,
    debounceMs: 250,
    pruneMs: 1000,
    max: 3,
  })
  return { watcher, events, granted, ...fake }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('FolderWatcher', () => {
  it('watches each expanded folder once and reports a burst of changes once, within 250ms', async () => {
    const { watcher, open, events } = setup()
    await watcher.sync([A, B, A])
    expect([...open.keys()]).toEqual(['/rA/', '/rA/src'])
    open.get('/rA/src')?.change()
    open.get('/rA/src')?.change()
    open.get('/rA/src')?.change()
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(250)
    expect(events).toEqual([{ rootId: 'rA', rel: 'src' }])
  })

  it('stops watching a folder when it is collapsed', async () => {
    const { watcher, open, closed, events } = setup()
    await watcher.sync([A, B])
    open.get('/rA/src')?.change()
    await watcher.sync([A])
    expect(closed).toEqual(['/rA/src'])
    expect([...open.keys()]).toEqual(['/rA/'])
    // A change already queued for the collapsed folder is dropped.
    await vi.advanceTimersByTimeAsync(1000)
    expect(events).toEqual([])
    await watcher.sync([])
    expect(open.size).toBe(0)
    expect(watcher.active()).toEqual([])
  })

  it('stops (and says so) when the grant is removed: on the next event or the next prune', async () => {
    const { watcher, open, granted, events } = setup()
    await watcher.sync([A, OTHER])
    granted.delete('rB')
    await vi.advanceTimersByTimeAsync(1000)
    expect([...open.keys()]).toEqual(['/rA/'])
    expect(events).toEqual([{ rootId: 'rB', rel: '', stopped: true }])

    granted.delete('rA')
    open.get('/rA/')?.change()
    expect(open.size).toBe(0)
    expect(events.at(-1)).toEqual({ rootId: 'rA', rel: '', stopped: true })
  })

  it('never starts watching an ungranted or refused folder', async () => {
    const { watcher, open, events } = setup({ refuse: ['escape'] })
    await watcher.sync([
      { rootId: 'rZ', rel: '' },
      { rootId: 'rA', rel: 'escape' },
    ])
    expect(open.size).toBe(0)
    expect(events).toEqual([{ rootId: 'rA', rel: 'escape', stopped: true }])
  })

  it('stops a watcher that errors (folder deleted, handle lost) and reports it', async () => {
    const { watcher, open, events } = setup()
    await watcher.sync([B])
    open.get('/rA/src')?.error(new Error('EPERM'))
    expect(open.size).toBe(0)
    expect(events).toEqual([{ rootId: 'rA', rel: 'src', stopped: true }])
  })

  it('caps how many folders are watched', async () => {
    const { watcher, open } = setup()
    await watcher.sync(['a', 'b', 'c', 'd', 'e'].map((rel) => ({ rootId: 'rA', rel })))
    expect(open.size).toBe(3)
  })

  it('closes everything on close()', async () => {
    const { watcher, open } = setup()
    await watcher.sync([A, B])
    watcher.close()
    expect(open.size).toBe(0)
  })
})

describe('files service watching the real file system', () => {
  it('reports a new file in an expanded folder within about a second', async () => {
    const box = await makeSandbox()
    let roots = [box.root]
    const guard = new PathGuard({ roots: () => roots })
    const events: FilesChanged[] = []
    const files = createFilesService({
      guard,
      reveal: () => {},
      copyText: () => Promise.resolve(),
      emit: (change) => events.push(change),
    })
    try {
      await put(path.join(box.root, 'src', 'a.txt'))
      const src = { rootId: rootId(box.root), rel: 'src' }
      await files.watch([src])
      const started = Date.now()
      await put(path.join(box.root, 'src', 'b.txt'), 'new')
      await vi.waitFor(
        () => {
          expect(events).toContainEqual(src)
        },
        { timeout: 3000, interval: 20 },
      )
      expect(Date.now() - started).toBeLessThan(1500)

      // Removing the grant stops the watcher.
      roots = []
      await vi.waitFor(
        () => {
          expect(events).toContainEqual({ ...src, stopped: true })
        },
        { timeout: 3000, interval: 50 },
      )
    } finally {
      files.close()
      await box.cleanup()
    }
  })
})
