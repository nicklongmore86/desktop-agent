import { describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_PASTE_MAX_BYTES, attachmentsChannels } from '../shared/ipc-attachments'
import { attachmentsApi } from './attachments'
import type { Invoke } from './features'
import { filesApi } from './files'

const { getPathForFile } = vi.hoisted(() => ({
  getPathForFile: vi.fn((_file: File) => '/home/me/dropped.txt'),
}))
vi.mock('electron', () => ({ webUtils: { getPathForFile } }))

/** An Invoke that records its calls (vi.fn cannot stand in for a generic function type). */
function recorder() {
  const calls: unknown[][] = []
  const invoke: Invoke = <T>(...args: unknown[]) => {
    calls.push(args)
    return Promise.resolve(undefined as T)
  }
  return { invoke, calls }
}

const file = new File(['contents never cross IPC'], 'dropped.txt')

describe('files.attachDropped', () => {
  it('reads the path in the preload and sends only that string', async () => {
    const { invoke, calls } = recorder()
    await filesApi(invoke, vi.fn()).files.attachDropped(file)
    expect(getPathForFile).toHaveBeenCalledWith(file)
    expect(calls.at(-1)).toEqual([
      attachmentsChannels.attachmentsAttachDropped,
      '/home/me/dropped.txt',
    ])
  })

  it('refuses a File with no path on disk (zip-folder drags) without calling main', async () => {
    const { invoke, calls } = recorder()
    for (const pathForFile of [
      () => '',
      () => {
        throw new Error('not a File from this page')
      },
    ]) {
      expect(await filesApi(invoke, vi.fn(), pathForFile).files.attachDropped(file)).toMatchObject({
        ok: false,
        code: 'invalid',
      })
    }
    expect(calls).toEqual([])
  })
})

describe('attachments bridge', () => {
  it('caps pastes before copying the bytes across', async () => {
    const { invoke, calls } = recorder()
    const api = attachmentsApi(invoke).attachments
    expect(
      await api.fromPaste(new Uint8Array(ATTACHMENT_PASTE_MAX_BYTES + 1), 'image/png'),
    ).toMatchObject({
      ok: false,
      code: 'too-large',
    })
    expect(calls).toEqual([])
    const bytes = new Uint8Array([1])
    await api.fromPaste(bytes, 'image/png')
    expect(calls.at(-1)).toEqual([
      attachmentsChannels.attachmentsFromPaste,
      bytes,
      'image/png',
      undefined,
    ])
  })

  it('opens the picker with no arguments', async () => {
    const { invoke, calls } = recorder()
    await attachmentsApi(invoke).attachments.pick()
    expect(calls.at(-1)).toEqual([attachmentsChannels.attachmentsPick])
  })
})
