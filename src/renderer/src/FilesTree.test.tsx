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
import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../shared/ipc-files'
import { ApiContext } from './api'
import { App } from './App'
import { FILE_DRAG_TYPE } from './components/files/drag'
import { EXTERNAL_DROP_MESSAGE } from './components/files/external-drop'
import { fileKind } from './components/files/file-kind'
import { WINDOW_THRESHOLD } from './components/files/FileTree'
import { ToastProvider } from './components/Toast'
import { FAKE_FILES, fakeApi, fakeRootId, type FakeApiOptions } from './test/fake-api'
import { setViewport } from './test/viewport'

const ROOT = 'C:\\Users\\me\\Projects'
const ROOT_ID = fakeRootId(ROOT)

async function renderApp(options: FakeApiOptions = {}) {
  setViewport(1280)
  const fake = fakeApi(options)
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ApiContext>,
  )
  await screen.findByRole('heading', { name: 'Workspace chat' })
  if ((options.grants?.roots.length ?? 1) > 0)
    await screen.findByRole('treeitem', { name: /README\.md/ })
  return { ...fake, user }
}

const tree = () => screen.getByRole('tree', { name: 'Files in granted folders' })
const item = (name: RegExp) => within(tree()).getByRole('treeitem', { name })
const activeItem = () => {
  const id = tree().getAttribute('aria-activedescendant')
  return id ? document.getElementById(id) : null
}
const composer = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' })

/** A DataTransfer double: jsdom has none. */
function dataTransfer() {
  const data = new Map<string, string>()
  return {
    data,
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    clearData: () => {
      data.clear()
    },
    effectAllowed: 'all',
    dropEffect: 'none',
  }
}

describe('Files tree: ARIA tree', () => {
  it('shows each granted folder as an expanded root with its first level, folders first', async () => {
    await renderApp()
    const root = item(/^Projects/)
    expect(root.getAttribute('aria-level')).toBe('1')
    expect(root.getAttribute('aria-expanded')).toBe('true')
    expect(within(root).getByText(ROOT)).toBeTruthy()
    const names = within(tree())
      .getAllByRole('treeitem')
      .filter((row) => row.getAttribute('aria-level') === '2')
      .map((row) => row.querySelector('.tree-name')?.textContent)
    expect(names).toEqual(FAKE_FILES[`${ROOT}\n`]?.map((e) => e.name))
    expect(item(/^src/).getAttribute('aria-expanded')).toBe('false')
    expect(item(/^README\.md/).getAttribute('aria-expanded')).toBeNull()
    expect(item(/^README\.md/).getAttribute('aria-posinset')).toBe('5')
    expect(item(/^README\.md/).getAttribute('aria-setsize')).toBe('7')
  })

  it('moves with the arrow keys, expands and collapses folders, and lazy-loads them', async () => {
    const { user, api } = await renderApp()
    tree().focus()
    expect(activeItem()?.textContent).toMatch(/^.*Projects/)
    await user.keyboard('{ArrowDown}')
    expect(activeItem()).toBe(item(/^src/))
    expect(api.files.list).not.toHaveBeenCalledWith({ rootId: ROOT_ID, rel: 'src' })
    await user.keyboard('{ArrowRight}')
    expect(api.files.list).toHaveBeenCalledWith({ rootId: ROOT_ID, rel: 'src' })
    await within(tree()).findByRole('treeitem', { name: /^App\.tsx/ })
    expect(item(/^src/).getAttribute('aria-expanded')).toBe('true')
    await user.keyboard('{ArrowRight}')
    expect(activeItem()).toBe(item(/^lib/))
    expect(activeItem()?.getAttribute('aria-level')).toBe('3')
    await user.keyboard('{ArrowLeft}')
    expect(activeItem()).toBe(item(/^src/))
    await user.keyboard('{ArrowLeft}')
    expect(item(/^src/).getAttribute('aria-expanded')).toBe('false')
    expect(within(tree()).queryByRole('treeitem', { name: /^App\.tsx/ })).toBeNull()
    await user.keyboard('{End}')
    expect(activeItem()).toBe(item(/^linked\.txt/))
    await user.keyboard('{Home}')
    expect(activeItem()).toBe(item(/^Projects/))
    // Left on the root collapses it; Right opens it again.
    await user.keyboard('{ArrowLeft}')
    expect(item(/^Projects/).getAttribute('aria-expanded')).toBe('false')
    await user.keyboard('{ArrowRight}')
    expect(item(/^Projects/).getAttribute('aria-expanded')).toBe('true')
  })

  it('says what each locked entry is in its accessible name, and never makes it draggable', async () => {
    await renderApp()
    expect(item(/^\.env, Blocked: ".env" is blocked/)).toBeTruthy()
    expect(item(/^escape.*Link outside granted folders, not followed/)).toBeTruthy()
    expect(item(/^secrets\.json.*Secret file, contents hidden/)).toBeTruthy()
    expect(item(/^linked\.txt.*has other hard links/)).toBeTruthy()
    for (const name of [/^\.env/, /^\.ssh/, /^escape/, /^secrets\.json/, /^linked\.txt/])
      expect(item(name).getAttribute('draggable'), String(name)).toBe('false')
    expect(item(/^README\.md/).getAttribute('draggable')).toBe('true')
    expect(item(/^src,/).getAttribute('draggable')).toBe('true')
    // Links are never expandable: they are not followed.
    expect(item(/^escape/).getAttribute('aria-expanded')).toBeNull()
  })

  it('colours files by type, with a different icon shape per type', () => {
    expect(fileKind('report.PDF')).toBe('pdf')
    expect(fileKind('budget.xlsx')).toBe('sheet')
    expect(fileKind('deck.pptx')).toBe('slide')
    expect(fileKind('notes.md')).toBe('doc')
    expect(fileKind('App.tsx')).toBe('code')
    expect(fileKind('photo.jpeg')).toBe('image')
    expect(fileKind('clip.mp4')).toBe('media')
    expect(fileKind('backup.7z')).toBe('archive')
    expect(fileKind('Makefile')).toBe('other')
    expect(fileKind('.gitignore')).toBe('other')
  })
})

describe('Files tree: watching', () => {
  it('keeps main watching exactly the expanded folders', async () => {
    const { user, api } = await renderApp()
    const root = { rootId: ROOT_ID, rel: '' }
    const src = { rootId: ROOT_ID, rel: 'src' }
    await waitFor(() => {
      expect(api.files.watch).toHaveBeenLastCalledWith([root])
    })
    await user.click(item(/^src/))
    await waitFor(() => {
      expect(api.files.watch).toHaveBeenLastCalledWith([root, src])
    })
    await user.click(item(/^src/))
    await waitFor(() => {
      expect(api.files.watch).toHaveBeenLastCalledWith([root])
    })
  })

  it('re-lists a folder main reports as changed, and offers a refresh when watching stopped', async () => {
    const files = { ...FAKE_FILES }
    const { api, pushFilesChanged, user } = await renderApp({ files })
    files[`${ROOT}\n`] = [
      ...(FAKE_FILES[`${ROOT}\n`] ?? []),
      { name: 'new-file.txt', rel: 'new-file.txt', kind: 'file' },
    ]
    act(() => {
      pushFilesChanged({ rootId: ROOT_ID, rel: '' })
    })
    expect(await within(tree()).findByRole('treeitem', { name: /^new-file\.txt/ })).toBeTruthy()

    act(() => {
      pushFilesChanged({ rootId: ROOT_ID, rel: '', stopped: true })
    })
    const refresh = await screen.findByRole('button', { name: 'Refresh Projects' })
    const calls = api.files.list.mock.calls.length
    await user.click(refresh)
    expect(api.files.list.mock.calls.length).toBe(calls + 1)
    expect(screen.queryByRole('button', { name: 'Refresh Projects' })).toBeNull()
  })

  it('drops a removed folder from the tree and from the watch list', async () => {
    const { user, api } = await renderApp()
    await user.click(screen.getByRole('button', { name: `Remove ${ROOT}` }))
    expect(api.grants.remove).toHaveBeenCalledWith(ROOT)
    expect(await screen.findByText('No folders granted')).toBeTruthy()
    expect(screen.queryByRole('tree')).toBeNull()
    await waitFor(() => {
      expect(api.files.watch).toHaveBeenLastCalledWith([])
    })
  })

  it('works with no grants: an empty state with Add folder', async () => {
    const { user, api } = await renderApp({ grants: { roots: [], loadError: null } })
    expect(screen.getByText('No folders granted')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add folder…' }))
    expect(api.grants.add).toHaveBeenCalledOnce()
  })
})

describe('Files tree: actions', () => {
  it('opens the context menu from the keyboard and copies, reveals and inserts references', async () => {
    const { user, api } = await renderApp()
    tree().focus()
    await user.keyboard('{End}{ArrowUp}{ArrowUp}')
    expect(activeItem()).toBe(item(/^README\.md/))
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menu = screen.getByRole('menu', { name: 'Actions for README.md' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Insert reference into chat', 'Copy path', 'Reveal in Explorer'])
    expect(within(menu).getByRole('menuitem', { name: 'Insert reference into chat' })).toBe(
      document.activeElement,
    )
    await user.keyboard('{ArrowDown}{Enter}')
    expect(api.files.copyPath).toHaveBeenCalledWith({ rootId: ROOT_ID, rel: 'README.md' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(tree())

    fireEvent.contextMenu(item(/^README\.md/))
    await user.click(screen.getByRole('menuitem', { name: 'Reveal in Explorer' }))
    expect(api.files.reveal).toHaveBeenCalledWith({ rootId: ROOT_ID, rel: 'README.md' })

    fireEvent.contextMenu(item(/^README\.md/))
    await user.click(screen.getByRole('menuitem', { name: 'Insert reference into chat' }))
    await waitFor(() => {
      expect(composer().value).toBe(`@"${ROOT}\\README.md" `)
    })
  })

  it('keeps unavailable actions in the menu, disabled, with the reason', async () => {
    const { user, api } = await renderApp()
    fireEvent.contextMenu(item(/^secrets\.json/))
    const menu = screen.getByRole('menu', { name: 'Actions for secrets.json' })
    expect(within(menu).getByText(/contents stay hidden/)).toBeTruthy()
    const insert = within(menu).getByRole('menuitem', { name: 'Insert reference into chat' })
    expect(insert.getAttribute('aria-disabled')).toBe('true')
    await user.click(insert)
    expect(api.files.reference).not.toHaveBeenCalled()
    // Copying the path opens nothing; revealing it in Explorer is refused.
    expect(
      within(menu).getByRole('menuitem', { name: 'Copy path' }).getAttribute('aria-disabled'),
    ).toBeNull()
    const reveal = within(menu).getByRole('menuitem', { name: 'Reveal in Explorer' })
    expect(reveal.getAttribute('aria-disabled')).toBe('true')
    expect(reveal.getAttribute('title')).toBe('Secret files cannot be opened or revealed.')
    await user.click(reveal)
    expect(api.files.reveal).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(item(/^escape/))
    const linkMenu = screen.getByRole('menu', { name: 'Actions for escape' })
    for (const entry of within(linkMenu).getAllByRole('menuitem'))
      expect(entry.getAttribute('aria-disabled'), entry.textContent).toBe('true')
  })

  it('inserts a file reference with Enter on a file, at the caret, spaced from the text', async () => {
    const { user } = await renderApp()
    await user.type(composer(), 'Summarise')
    tree().focus()
    await user.keyboard('{End}{ArrowUp}{ArrowUp}{Enter}')
    await waitFor(() => {
      expect(composer().value).toBe(`Summarise @"${ROOT}\\README.md" `)
    })
  })

  it('offers Remove folder access on a granted folder', async () => {
    const { user, api } = await renderApp()
    fireEvent.contextMenu(item(/^Projects/))
    await user.click(screen.getByRole('menuitem', { name: 'Remove folder access' }))
    expect(api.grants.remove).toHaveBeenCalledWith(ROOT)
  })
})

describe('Files tree: drag to chat', () => {
  it('drops a reference into the message box, carrying only a token', async () => {
    const { api } = await renderApp()
    const transfer = dataTransfer()
    fireEvent.dragStart(item(/^README\.md/), { dataTransfer: transfer })
    // Only the private type, holding a random token: no path, text, URL or file.
    expect(transfer.types).toEqual([FILE_DRAG_TYPE])
    expect(transfer.getData(FILE_DRAG_TYPE)).not.toContain('README')
    expect(transfer.effectAllowed).toBe('link')
    const over = fireEvent.dragOver(composer(), { dataTransfer: transfer })
    expect(over).toBe(false) // preventDefault: the box accepts it
    fireEvent.drop(composer(), { dataTransfer: transfer })
    await waitFor(() => {
      expect(composer().value).toBe(`@"${ROOT}\\README.md" `)
    })
    expect(api.files.reference).toHaveBeenCalledWith({ rootId: ROOT_ID, rel: 'README.md' })
  })

  it('ignores a forged drop and never attaches files dragged in from outside', async () => {
    const { api } = await renderApp()
    const real = dataTransfer()
    fireEvent.dragStart(item(/^README\.md/), { dataTransfer: real })
    const forged = dataTransfer()
    forged.setData(FILE_DRAG_TYPE, 'guess')
    fireEvent.drop(composer(), { dataTransfer: forged })
    const outside = dataTransfer()
    outside.setData('Files', '')
    fireEvent.drop(composer(), { dataTransfer: outside })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.files.reference).not.toHaveBeenCalled()
    expect(composer().value).toBe('')
  })

  it('has nothing to drop onto inside the tree (no implicit moves)', async () => {
    await renderApp()
    const transfer = dataTransfer()
    fireEvent.dragStart(item(/^README\.md/), { dataTransfer: transfer })
    expect(fireEvent.dragOver(item(/^src/), { dataTransfer: transfer })).toBe(true)
    expect(fireEvent.drop(item(/^src/), { dataTransfer: transfer })).toBe(true)
  })
})

describe('Files from outside the app', () => {
  const external = () => {
    const transfer = dataTransfer()
    transfer.setData('Files', '')
    return transfer
  }
  const chat = () => composer().closest<HTMLElement>('.chat') as HTMLElement
  const pane = () => tree().closest<HTMLElement>('.files-tab') as HTMLElement

  it.each([
    ['the message box', composer],
    ['the chat column', chat],
    ['the file tree pane', pane],
  ])('hints over %s, refuses with a toast on drop, and inserts nothing', async (_name, zone) => {
    const { api } = await renderApp()
    const transfer = external()
    expect(fireEvent.dragEnter(zone(), { dataTransfer: transfer })).toBe(false)
    expect(fireEvent.dragOver(zone(), { dataTransfer: transfer })).toBe(false) // accepted so `drop` fires
    expect(transfer.dropEffect).toBe('copy')
    expect(screen.getAllByTestId('external-drop-hint')).toHaveLength(1)
    expect(fireEvent.drop(zone(), { dataTransfer: transfer })).toBe(false) // no navigation
    expect(screen.queryByTestId('external-drop-hint')).toBeNull()
    expect((await screen.findByRole('status')).textContent).toBe(EXTERNAL_DROP_MESSAGE)
    expect(EXTERNAL_DROP_MESSAGE).toContain('Settings → Folders')
    expect(composer().value).toBe('')
    expect(api.files.reference).not.toHaveBeenCalled()
  })

  it('clears the hint when the drag leaves the zone', async () => {
    await renderApp()
    fireEvent.dragEnter(chat(), { dataTransfer: external() })
    const leave = (from: HTMLElement, to: Element) => {
      const event = createEvent.dragLeave(from, { dataTransfer: external() })
      Object.defineProperty(event, 'relatedTarget', { value: to })
      fireEvent(from, event)
    }
    leave(composer(), chat()) // moved between children: still over the zone
    expect(screen.getByTestId('external-drop-hint')).toBeTruthy()
    leave(chat(), document.body)
    expect(screen.queryByTestId('external-drop-hint')).toBeNull()
  })

  it('leaves the tree drag and other drags alone', async () => {
    await renderApp()
    const own = dataTransfer()
    fireEvent.dragStart(item(/^README\.md/), { dataTransfer: own })
    // A tree token never shows the hint, even with a 'Files' type alongside it.
    own.setData('Files', '')
    fireEvent.dragEnter(chat(), { dataTransfer: own })
    expect(screen.queryByTestId('external-drop-hint')).toBeNull()
    const text = dataTransfer()
    text.setData('text/plain', 'hello')
    expect(fireEvent.dragOver(pane(), { dataTransfer: text })).toBe(true)
    expect(fireEvent.drop(pane(), { dataTransfer: text })).toBe(true)
  })
})

describe('the @ mention menu', () => {
  it('searches the granted folders and inserts the chosen file as a reference', async () => {
    const { user, api } = await renderApp()
    await user.type(composer(), 'Look at @app')
    const list = await screen.findByRole('listbox', { name: 'Files to reference' })
    const option = await within(list).findByRole('option', { name: /App\.tsx/ })
    expect(api.files.search).toHaveBeenLastCalledWith('app')
    expect(option.getAttribute('aria-selected')).toBe('true')
    expect(composer().getAttribute('aria-expanded')).toBe('true')
    expect(composer().getAttribute('aria-activedescendant')).toBe(option.id)
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(composer().value).toBe(`Look at @"${ROOT}\\src\\App.tsx" `)
    })
    expect(screen.queryByRole('listbox')).toBeNull()
    // Enter chose the file; it did not send the message.
    expect(api.chat.send).not.toHaveBeenCalled()
  })

  it('moves with the arrow keys, hints when empty, and closes with Escape without stopping a reply', async () => {
    const { user, api, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r', text: 'Hi' })
    })
    await user.type(composer(), '@')
    expect(await screen.findByText('Type a file name to search your granted folders')).toBeTruthy()
    await user.type(composer(), 'a')
    const list = await screen.findByRole('listbox')
    await within(list).findAllByRole('option')
    const options = within(list).getAllByRole('option')
    expect(options.length).toBeGreaterThan(1)
    await user.keyboard('{ArrowDown}')
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(api.chat.stop).not.toHaveBeenCalled()
    expect(composer().value).toBe('@a')

    await user.clear(composer())
    await user.type(composer(), '@zzz')
    expect(await screen.findByText('No matching files in your granted folders')).toBeTruthy()
  })

  it('does not open for an @ inside a word (an email address)', async () => {
    const { user } = await renderApp()
    await user.type(composer(), 'mail me@home')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('Files tree: big folders', () => {
  it('draws only the visible rows of a huge folder, and keeps the keyboard position', async () => {
    const many: FileEntry[] = Array.from({ length: 600 }, (_, i) => ({
      name: `file-${String(i).padStart(3, '0')}.txt`,
      rel: `file-${String(i).padStart(3, '0')}.txt`,
      kind: 'file',
    }))
    const { user } = await renderApp({
      files: { ...FAKE_FILES, [`${ROOT}\n`]: [...(FAKE_FILES[`${ROOT}\n`] ?? []), ...many] },
    })
    const drawn = within(tree()).getAllByRole('treeitem').length
    expect(drawn).toBeGreaterThan(10)
    expect(drawn).toBeLessThan(WINDOW_THRESHOLD)
    tree().focus()
    await user.keyboard('{End}')
    expect(activeItem()?.textContent).toMatch(/^.*file-599\.txt/)
  })
})
