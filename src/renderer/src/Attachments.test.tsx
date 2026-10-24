import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentRef } from '../../shared/attachments'
import type { AttachOutcome } from '../../shared/ipc-attachments'
import { ApiContext } from './api'
import { App } from './App'
import { clearThumbnails } from './attachments/thumbnails'
import { ToastProvider } from './components/Toast'
import { fakeApi, type FakeApiOptions } from './test/fake-api'
import { setViewport } from './test/viewport'

async function renderApp(options: FakeApiOptions = {}) {
  setViewport(1280)
  const fake = fakeApi(options)
  const user = userEvent.setup()
  const view = render(
    <ApiContext value={fake.api}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ApiContext>,
  )
  await screen.findByRole('heading', { name: 'Workspace chat' })
  return { ...fake, user, unmount: view.unmount }
}

const composer = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' })
const chipList = () => screen.getByRole('list', { name: 'Attached files' })
const chips = () => screen.queryByRole('list', { name: 'Attached files' })

const ref = (n: number, extra: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: n.toString(16).padStart(64, '0'),
  name: `file${String(n)}.txt`,
  kind: 'text',
  mime: 'text/plain',
  size: 2048,
  ...extra,
})
const attachment = (a: AttachmentRef, outsideGrant = false): AttachOutcome => ({
  ok: true,
  kind: 'attachment',
  attachment: a,
  outsideGrant,
})

describe('chips above the composer', () => {
  it('shows a chip with name, size and remove for a picked file, and removes it', async () => {
    const { api, user } = await renderApp()
    api.attachments.pick.mockResolvedValueOnce([
      attachment(ref(1, { name: 'notes.md', size: 1536 })),
    ])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    const list = await screen.findByRole('list', { name: 'Attached files' })
    expect(within(list).getByText('notes.md')).toBeTruthy()
    expect(within(list).getByText('1.5 KB')).toBeTruthy()
    await user.click(within(list).getByRole('button', { name: 'Remove notes.md' }))
    expect(chips()).toBeNull()
  })

  it('has a labelled, keyboard-reachable paperclip', async () => {
    const { api, user } = await renderApp()
    const button = screen.getByRole('button', { name: 'Attach files' })
    expect(button.getAttribute('title')).toBe('Attach files')
    api.attachments.pick.mockResolvedValueOnce([])
    button.focus()
    await user.keyboard('{Enter}')
    expect(api.attachments.pick).toHaveBeenCalledOnce()
  })

  it('greys a file the model cannot receive yet and says why; text files, PDFs and Office documents are not greyed', async () => {
    const { api, user } = await renderApp()
    api.attachments.pick.mockResolvedValueOnce([
      attachment(ref(1, { name: 'photo.png', kind: 'image', mime: 'image/png' })),
      attachment(ref(2, { name: 'plain.txt' })),
      attachment(ref(4, { name: 'doc.pdf', kind: 'pdf', mime: 'application/pdf' })),
      attachment(
        ref(5, {
          name: 'notes.docx',
          kind: 'document',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
      attachment(
        ref(6, { name: 'old.ppt', kind: 'document', mime: 'application/vnd.ms-powerpoint' }),
      ),
    ])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    const list = await screen.findByRole('list', { name: 'Attached files' })
    const [photo, plain, pdf, doc, ppt] = within(list).getAllByRole('listitem')
    expect(photo?.className).toContain('attachment-chip-muted')
    expect(photo?.getAttribute('title')).toContain('This model can’t see images')
    expect(ppt?.className).toContain('attachment-chip-muted')
    expect(ppt?.getAttribute('title')).toContain(
      'Not sent to this model yet; it will see the file name only.',
    )
    expect(plain?.className).not.toContain('attachment-chip-muted')
    // PDFs and Word, Excel, PowerPoint and OpenDocument files are read as text for every model.
    expect(pdf?.className).not.toContain('attachment-chip-muted')
    expect(doc?.className).not.toContain('attachment-chip-muted')
  })

  it('makes image chips active for a connection whose model can see images', async () => {
    const vision = {
      enabled: true,
      source: 'connection' as const,
      setting: false,
      configurable: false,
    }
    const { api, user } = await renderApp({ vision: { 'anthropic-api': vision } })
    api.attachments.pick.mockResolvedValueOnce([
      attachment(ref(1, { name: 'photo.png', kind: 'image', mime: 'image/png' })),
      attachment(ref(4, { name: 'doc.pdf', kind: 'pdf', mime: 'application/pdf' })),
    ])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    const list = await screen.findByRole('list', { name: 'Attached files' })
    await waitFor(() => {
      expect(within(list).getAllByRole('listitem')[0]?.className).not.toContain(
        'attachment-chip-muted',
      )
    })
    // PDFs reach every model, as text (and drawn pages as images here).
    expect(within(list).getAllByRole('listitem')[1]?.className).not.toContain(
      'attachment-chip-muted',
    )
    expect(api.connections.vision).toHaveBeenCalledWith('anthropic-api')
  })

  it('offers "Copy into folder…" on a snapshot from outside the grants', async () => {
    const { api, user } = await renderApp()
    const outside = ref(3, { name: 'report.txt' })
    api.attachments.pick.mockResolvedValueOnce([attachment(outside, true)])
    api.attachments.copyIntoFolder.mockResolvedValueOnce({
      ok: true,
      text: '@"C:\\Users\\me\\Projects\\report.txt"',
    })
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    await user.click(await screen.findByRole('button', { name: 'Copy into folder…' }))
    await waitFor(() => {
      expect(api.attachments.copyIntoFolder).toHaveBeenCalledExactlyOnceWith(
        outside.id,
        expect.objectContaining({ rel: '' }),
      )
    })
    // The copy is now a normal reference in the message, and the snapshot chip is gone.
    await waitFor(() => {
      expect(composer().value).toContain('@"C:\\Users\\me\\Projects\\report.txt"')
    })
    expect(chips()).toBeNull()
  })

  it('stays quiet when the approval is declined', async () => {
    const { api, user } = await renderApp()
    api.attachments.pick.mockResolvedValueOnce([attachment(ref(3), true)])
    api.attachments.copyIntoFolder.mockResolvedValueOnce({
      ok: false,
      declined: true,
      reason: 'Not approved.',
    })
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    await user.click(await screen.findByRole('button', { name: 'Copy into folder…' }))
    await waitFor(() => {
      expect(api.attachments.copyIntoFolder).toHaveBeenCalled()
    })
    expect(screen.queryByText('Not approved.')).toBeNull()
    expect(chips()).not.toBeNull()
  })
})

describe('what a file becomes', () => {
  it('inserts an @ reference for an in-grant text file instead of a chip', async () => {
    const { api, user } = await renderApp()
    await user.type(composer(), 'Look at ')
    api.attachments.pick.mockResolvedValueOnce([
      { ok: true, kind: 'reference', text: '@"C:\\Users\\me\\Projects\\README.md"' },
    ])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    await waitFor(() => {
      expect(composer().value).toBe('Look at @"C:\\Users\\me\\Projects\\README.md" ')
    })
    expect(chips()).toBeNull()
  })

  it('shows a toast for a refusal, and a button to Settings → Folders for an ungranted folder', async () => {
    const { api, user } = await renderApp()
    api.attachments.pick.mockResolvedValueOnce([
      { ok: false, code: 'grant-folder', reason: 'Not in a granted folder.' },
    ])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(await screen.findByText(/Settings → Folders/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
  })

  it.each([
    ['secret', 'Secret files are never attached.'],
    ['too-large', 'x.bin is over the limit.'],
    ['binary', 'x.exe cannot be attached.'],
  ] as const)("shows main's reason for a %s refusal", async (code, reason) => {
    const { api, user } = await renderApp()
    api.attachments.pick.mockResolvedValueOnce([{ ok: false, code, reason }])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(await screen.findByText(reason)).toBeTruthy()
    expect(chips()).toBeNull()
  })

  it('refuses the eleventh file and tells the user', async () => {
    const { api, user } = await renderApp()
    api.attachments.pick.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => attachment(ref(i + 1))),
    )
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    await screen.findByRole('list', { name: 'Attached files' })
    api.attachments.pick.mockResolvedValueOnce([attachment(ref(99))])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(await screen.findByText('You can attach up to 10 files to a message.')).toBeTruthy()
    expect(within(chipList()).getAllByRole('button', { name: /^Remove / })).toHaveLength(10)
  })

  it('refuses files over 20 MB in all', async () => {
    const { api, user } = await renderApp()
    const big = 12 * 1024 * 1024
    api.attachments.pick.mockResolvedValueOnce([
      attachment(ref(1, { size: big })),
      attachment(ref(2, { size: big })),
    ])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(await screen.findByText(/up to 20 MB/)).toBeTruthy()
    expect(within(chipList()).getAllByRole('button', { name: /^Remove / })).toHaveLength(1)
  })
})

describe('drop and paste', () => {
  const dropOn = (target: Element, files: File[]) => {
    const transfer = { types: ['Files'], files, dropEffect: 'none', getData: () => '' }
    fireEvent.dragEnter(target, { dataTransfer: transfer })
    fireEvent.drop(target, { dataTransfer: transfer })
  }

  it('attaches each dropped File through files.attachDropped', async () => {
    const { api } = await renderApp()
    const a = new File(['a'], 'a.txt', { type: 'text/plain' })
    const b = new File(['b'], 'b.txt', { type: 'text/plain' })
    api.files.attachDropped
      .mockResolvedValueOnce(attachment(ref(1, { name: 'a.txt' })))
      .mockResolvedValueOnce(attachment(ref(2, { name: 'b.txt' })))
    dropOn(composer(), [a, b])
    await screen.findByRole('list', { name: 'Attached files' })
    expect(api.files.attachDropped).toHaveBeenCalledTimes(2)
    expect(api.files.attachDropped).toHaveBeenCalledWith(a)
    expect(api.files.attachDropped).toHaveBeenCalledWith(b)
    expect(within(chipList()).getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
  })

  it('inserts several dropped references in one go, in order', async () => {
    const { api } = await renderApp()
    api.files.attachDropped
      .mockResolvedValueOnce({ ok: true, kind: 'reference', text: '@"C:\\p\\a.md"' })
      .mockResolvedValueOnce({ ok: true, kind: 'reference', text: '@"C:\\p\\b.md"' })
    dropOn(composer(), [new File(['a'], 'a.md'), new File(['b'], 'b.md')])
    await waitFor(() => {
      expect(composer().value).toContain('@"C:\\p\\a.md" @"C:\\p\\b.md"')
    })
  })

  it('attaches an image pasted from the clipboard through attachments.fromPaste', async () => {
    const { api } = await renderApp()
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })
    api.files.attachDropped.mockResolvedValueOnce({
      ok: false,
      code: 'invalid',
      reason: 'This item is not a file on disk.',
    })
    api.attachments.fromPaste.mockResolvedValueOnce(
      attachment(ref(5, { name: 'image.png', kind: 'image', mime: 'image/png' })),
    )
    const event = createEvent.paste(composer(), {
      clipboardData: { files: [png], types: ['Files'] },
    })
    act(() => {
      fireEvent(composer(), event)
    })
    expect(event.defaultPrevented).toBe(true)
    await screen.findByRole('list', { name: 'Attached files' })
    expect(api.attachments.fromPaste).toHaveBeenCalledOnce()
    const [bytes, mime, name] = api.attachments.fromPaste.mock.calls[0] ?? []
    expect(Array.from(bytes ?? [])).toEqual([137, 80, 78, 71])
    expect([mime, name]).toEqual(['image/png', 'image.png'])
  })

  it('leaves a plain-text paste alone', async () => {
    const { api } = await renderApp()
    const event = createEvent.paste(composer(), {
      clipboardData: { files: [], types: ['text/plain'] },
    })
    fireEvent(composer(), event)
    expect(event.defaultPrevented).toBe(false)
    expect(api.files.attachDropped).not.toHaveBeenCalled()
  })
})

describe('sending', () => {
  it('sends the staged ids with the text, then clears the chips', async () => {
    const { api, user } = await renderApp()
    const one = ref(1)
    api.attachments.pick.mockResolvedValueOnce([attachment(one)])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    await screen.findByRole('list', { name: 'Attached files' })
    await user.type(composer(), 'Summarise')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(api.chat.send).toHaveBeenCalledExactlyOnceWith('Summarise', [one.id])
    await waitFor(() => {
      expect(chips()).toBeNull()
    })
  })

  it('allows a message that is only files', async () => {
    const { api, user } = await renderApp()
    api.attachments.pick.mockResolvedValueOnce([attachment(ref(1))])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    await screen.findByRole('list', { name: 'Attached files' })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(api.chat.send).toHaveBeenCalledWith('', [ref(1).id])
  })

  it('keeps the chips when the send is refused', async () => {
    const { api, user } = await renderApp()
    api.chat.send.mockResolvedValueOnce({ ok: false, code: 'internal', message: 'No.' })
    api.attachments.pick.mockResolvedValueOnce([attachment(ref(1))])
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    await screen.findByRole('list', { name: 'Attached files' })
    await user.type(composer(), 'x')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('No.')
    expect(chips()).not.toBeNull()
  })

  it('pauses attaching while a reply runs, because sending is paused too', async () => {
    const { api, pushChat: push, user } = await renderApp()
    act(() => {
      push({ type: 'run_started', runId: 'r1', text: 'hi' })
    })
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Attach files' })
    expect(button.disabled).toBe(true)
    fireEvent.drop(composer(), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['a'], 'a.txt')],
        getData: () => '',
      },
    })
    expect(api.files.attachDropped).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
  })
})

describe('sent messages', () => {
  it('shows the chips read-only on the sent message', async () => {
    const { pushChat: push } = await renderApp()
    act(() => {
      push({
        type: 'run_started',
        runId: 'r1',
        text: 'Read this',
        attachments: [ref(1, { name: 'notes.md' })],
      })
    })
    const message = (await screen.findByText('Read this')).closest('li') as HTMLElement
    const list = within(message).getByRole('list', { name: 'Attached files' })
    expect(within(list).getByText('notes.md')).toBeTruthy()
    expect(within(list).queryByRole('button')).toBeNull()
  })

  it('shows "Attachment no longer available" for a missing blob', async () => {
    await renderApp({
      chat: {
        running: false,
        loadError: null,
        items: [
          {
            kind: 'user',
            id: 'u1',
            text: 'Old question',
            attachments: [{ ...ref(1, { name: 'gone.pdf', kind: 'pdf' }), available: false }],
          },
          { kind: 'assistant', id: 'a1', text: 'Answer' },
        ],
        history: { conversations: [], activeId: null },
      },
    })
    const message = (await screen.findByText('Old question')).closest('li') as HTMLElement
    expect(within(message).getAllByText('Attachment no longer available').length).toBeGreaterThan(0)
  })

  it('resends a retried message with its available attachments', async () => {
    const one = ref(1)
    const gone = ref(2, { name: 'gone.txt' })
    const { api, user } = await renderApp({
      chat: {
        running: false,
        loadError: null,
        items: [
          {
            kind: 'user',
            id: 'u1',
            text: 'Again',
            attachments: [
              { ...one, available: true },
              { ...gone, available: false },
            ],
          },
        ],
        history: { conversations: [], activeId: null },
      },
    })
    await screen.findByText('Again')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(api.chat.send).toHaveBeenCalledExactlyOnceWith('Again', [one.id])
  })
})

describe('image previews', () => {
  // jsdom has no object URLs.
  let created: string[]
  const createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:app/${String(created.length)}-${blob instanceof File ? blob.name : ''}`
    created.push(url)
    return url
  })
  const revokeObjectURL = vi.fn()
  beforeEach(() => {
    created = []
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
  })
  afterEach(() => {
    clearThumbnails()
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  const png = (name: string) =>
    new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
  const imageRef = (n: number, name: string) =>
    ref(n, { name, kind: 'image', mime: 'image/png', size: 4 })
  const drop = (files: File[]) => {
    const transfer = { types: ['Files'], files, dropEffect: 'none', getData: () => '' }
    fireEvent.dragEnter(composer(), { dataTransfer: transfer })
    fireEvent.drop(composer(), { dataTransfer: transfer })
  }
  const thumbs = () => Array.from(document.querySelectorAll('img.attachment-chip-thumb'))

  async function dropImages(api: ReturnType<typeof fakeApi>['api'], names: string[]) {
    names.forEach((name, i) => {
      api.files.attachDropped.mockResolvedValueOnce(attachment(imageRef(i + 1, name)))
    })
    const files = names.map(png)
    drop(files)
    await waitFor(() => {
      expect(thumbs()).toHaveLength(names.length)
    })
    return files
  }

  it('previews a dropped image with an object URL of the File, never a data: URL', async () => {
    const { api } = await renderApp()
    const [file] = await dropImages(api, ['shot.png'])
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(file)
    expect(thumbs().map((img) => img.getAttribute('src'))).toEqual(created)
    expect(document.body.innerHTML).not.toContain('data:')
  })

  it('does not preview a file that is not a previewable image', async () => {
    const { api } = await renderApp()
    api.files.attachDropped.mockResolvedValueOnce(attachment(ref(1, { name: 'a.txt' })))
    drop([new File(['a'], 'a.txt', { type: 'text/plain' })])
    await screen.findByRole('list', { name: 'Attached files' })
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(thumbs()).toHaveLength(0)
  })

  it('revokes the preview when its chip is removed, and only that one', async () => {
    const { api, user } = await renderApp()
    await dropImages(api, ['one.png', 'two.png'])
    const one = created.find((url) => url.endsWith('one.png'))
    await user.click(within(chipList()).getByRole('button', { name: 'Remove one.png' }))
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(one)
    expect(thumbs().map((img) => img.getAttribute('src'))).toEqual(
      created.filter((url) => url !== one),
    )
  })

  it('revokes every preview when the draft is sent', async () => {
    const { api, user } = await renderApp()
    await dropImages(api, ['one.png', 'two.png'])
    await user.type(composer(), 'Look')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => {
      expect(chips()).toBeNull()
    })
    expect(revokeObjectURL.mock.calls.map(([url]) => url as string).sort()).toEqual(
      [...created].sort(),
    )
  })

  it('revokes the previews of files refused for the per-message limit', async () => {
    const { api } = await renderApp()
    api.attachments.pick.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => attachment(ref(100 + i))),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    await waitFor(() => {
      expect(within(chipList()).getAllByRole('listitem')).toHaveLength(10)
    })
    api.files.attachDropped.mockResolvedValueOnce(attachment(imageRef(1, 'extra.png')))
    drop([png('extra.png')])
    await screen.findByText('You can attach up to 10 files to a message.')
    expect(created).toHaveLength(1)
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(created[0])
  })

  it('revokes every staged preview on unmount', async () => {
    const { api, unmount } = await renderApp()
    await dropImages(api, ['one.png', 'two.png'])
    expect(revokeObjectURL).not.toHaveBeenCalled()
    unmount()
    expect(revokeObjectURL.mock.calls.map(([url]) => url as string).sort()).toEqual(
      [...created].sort(),
    )
  })
})
