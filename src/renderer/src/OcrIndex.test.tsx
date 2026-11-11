import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { OcrIndexJob } from '../../shared/ipc-ocr-index'
import { ApiContext } from './api'
import { App } from './App'
import { progressText } from './components/files/OcrIndexJobs'
import { ToastProvider } from './components/Toast'
import { fakeApi, fakeRootId, type FakeApiOptions } from './test/fake-api'
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
  await screen.findByRole('treeitem', { name: /README\.md/ })
  return { ...fake, user }
}

const tree = () => screen.getByRole('tree', { name: 'Files in granted folders' })
const item = (name: RegExp) => within(tree()).getByRole('treeitem', { name })

const job = (over: Partial<OcrIndexJob> = {}): OcrIndexJob => ({
  id: '0000000000000001',
  rootId: ROOT_ID,
  rel: 'src',
  name: 'src',
  path: `${ROOT}\\src`,
  state: 'reading',
  filesChecked: 1700,
  filesTotal: 1700,
  pagesDone: 1240,
  pagesTotal: 3100,
  pagesFailed: 0,
  minutesLeft: 18,
  cloudOnly: 0,
  skipped: 0,
  message: 'Reading scanned pages at low priority. Searches come first.',
  ...over,
})

describe('Files panel: indexing scanned documents', () => {
  it('starts from a folder’s context menu, then shows the job with its progress', async () => {
    const { user, api, pushOcrIndex } = await renderApp()
    fireEvent.contextMenu(item(/^src/))
    await user.click(screen.getByRole('menuitem', { name: 'Index scanned documents' }))
    expect(api.ocrIndex.start).toHaveBeenCalledWith({ rootId: ROOT_ID, rel: 'src' })
    const panel = await screen.findByRole('region', { name: 'Scanned documents' })
    expect(within(panel).getByText('Queued')).toBeTruthy()
    expect(await screen.findByText('Indexing scanned documents in the background')).toBeTruthy()

    act(() => {
      pushOcrIndex([job()])
    })
    const bar = within(panel).getByRole('progressbar', { name: 'Indexing src' })
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect(bar.getAttribute('aria-valuetext')).toBe(
      '1,240 of 3,100 pages read · about 18 minutes left',
    )
    expect(
      within(panel).getByText('1,240 of 3,100 pages read · about 18 minutes left'),
    ).toBeTruthy()
    expect(within(panel).getByText('Reading pages')).toBeTruthy()
    expect(within(panel).getByTitle(`${ROOT}\\src`).textContent).toBe('src')
  })

  it('offers it on a granted folder too, but not on files or locked entries', async () => {
    const { user, api } = await renderApp()
    fireEvent.contextMenu(item(/^Projects/))
    await user.click(screen.getByRole('menuitem', { name: 'Index scanned documents' }))
    expect(api.ocrIndex.start).toHaveBeenCalledWith({ rootId: ROOT_ID, rel: '' })
    fireEvent.contextMenu(item(/^README\.md/))
    expect(screen.queryByRole('menuitem', { name: 'Index scanned documents' })).toBeNull()
    await user.keyboard('{Escape}')
    fireEvent.contextMenu(item(/^escape/))
    expect(screen.queryByRole('menuitem', { name: 'Index scanned documents' })).toBeNull()
  })

  it('disables it, saying why, inside a folder already being indexed', async () => {
    const { user, api } = await renderApp({ ocrIndex: [job({ rel: '' })] })
    fireEvent.contextMenu(item(/^src/))
    const start = screen.getByRole('menuitem', { name: 'Index scanned documents' })
    expect(start.getAttribute('aria-disabled')).toBe('true')
    expect(start.getAttribute('title')).toBe(
      'Already being indexed: see Scanned documents above the tree.',
    )
    await user.click(start)
    expect(api.ocrIndex.start).not.toHaveBeenCalled()
  })

  it('pauses, resumes and cancels a job, and dismisses a finished one', async () => {
    const { user, api, pushOcrIndex } = await renderApp({ ocrIndex: [job()] })
    const panel = await screen.findByRole('region', { name: 'Scanned documents' })
    await user.click(within(panel).getByRole('button', { name: 'Pause indexing src' }))
    expect(api.ocrIndex.pause).toHaveBeenCalledWith('0000000000000001')
    await user.click(await within(panel).findByRole('button', { name: 'Resume indexing src' }))
    expect(api.ocrIndex.resume).toHaveBeenCalledWith('0000000000000001')
    await user.click(await within(panel).findByRole('button', { name: 'Cancel indexing src' }))
    expect(api.ocrIndex.cancel).toHaveBeenCalledWith('0000000000000001')
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Scanned documents' })).toBeNull()
    })

    act(() => {
      pushOcrIndex([
        job({
          state: 'finished',
          pagesDone: 3100,
          minutesLeft: null,
          cloudOnly: 2,
          pagesFailed: 3,
          message: 'Every scanned page that could be read has been read.',
        }),
      ])
    })
    const done = await screen.findByRole('region', { name: 'Scanned documents' })
    expect(within(done).getByText('Done')).toBeTruthy()
    expect(within(done).getByText('3 pages OCR could not read')).toBeTruthy()
    expect(
      within(done).getByText(
        '2 online-only files not downloaded: open them in Explorer to download, then index again',
      ),
    ).toBeTruthy()
    expect(within(done).queryByRole('button', { name: /Pause|Cancel/ })).toBeNull()
    await user.click(within(done).getByRole('button', { name: 'Dismiss indexing of src' }))
    expect(api.ocrIndex.dismiss).toHaveBeenCalledWith('0000000000000001')
  })

  it('shows a stopped job’s reason, offers to try again, and says main’s refusals', async () => {
    const { user, api } = await renderApp({
      ocrIndex: [
        job({
          state: 'stopped',
          message: 'Stopped: OCR failed on several pages in a row. Resume to try again.',
        }),
      ],
      ocrIndexStart: { ok: false, reason: 'Reading scanned pages needs Windows.' },
    })
    const panel = await screen.findByRole('region', { name: 'Scanned documents' })
    expect(within(panel).getByText(/OCR failed on several pages/)).toBeTruthy()
    // A stopped job holds nothing: the folder around it can be started (main refuses here).
    fireEvent.contextMenu(item(/^Projects/))
    await user.click(screen.getByRole('menuitem', { name: 'Index scanned documents' }))
    expect(await screen.findByText('Reading scanned pages needs Windows.')).toBeTruthy()
    await user.click(within(panel).getByRole('button', { name: 'Try indexing src again' }))
    expect(api.ocrIndex.resume).toHaveBeenCalledWith('0000000000000001')
    // Going again, it holds the folder around it.
    fireEvent.contextMenu(item(/^Projects/))
    expect(
      screen
        .getByRole('menuitem', { name: 'Index scanned documents' })
        .getAttribute('aria-disabled'),
    ).toBe('true')
  })

  it('announces a change of state politely, never each page, and never takes focus', async () => {
    const { pushOcrIndex } = await renderApp({ ocrIndex: [job()] })
    const panel = await screen.findByRole('region', { name: 'Scanned documents' })
    const live = panel.querySelectorAll('[aria-live]')
    expect(live).toHaveLength(1)
    expect(live[0]?.getAttribute('aria-live')).toBe('polite')
    expect(live[0]?.textContent).toBe('src: Reading pages')
    tree().focus()
    act(() => {
      pushOcrIndex([job({ pagesDone: 1300 })])
      pushOcrIndex([job({ state: 'battery', message: 'Paused on battery.' })])
    })
    expect(live[0]?.textContent).toBe('src: Paused on battery')
    expect(document.activeElement).toBe(tree())
  })
})

describe('indexing progress in words', () => {
  it('counts PDFs while checking, then pages, with the estimate once there is one', () => {
    expect(progressText(job({ state: 'checking', filesChecked: 12, filesTotal: 1700 }))).toBe(
      '12 of 1,700 PDFs checked',
    )
    expect(progressText(job({ minutesLeft: null }))).toBe('1,240 of 3,100 pages read')
    expect(progressText(job({ minutesLeft: 1 }))).toBe(
      '1,240 of 3,100 pages read · about 1 minute left',
    )
    expect(progressText(job({ state: 'queued', pagesTotal: 0, filesTotal: 0 }))).toBe(
      'Not started yet',
    )
  })
})
