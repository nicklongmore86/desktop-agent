import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT } from '../../shared/ipc-layout'
import { ApiContext } from './api'
import { App } from './App'
import { FAKE_GIT_STATUS, fakeApi, fakeRootId, type FakeApiOptions } from './test/fake-api'
import { setViewport } from './test/viewport'

const ROOT = 'C:\\Users\\me\\Projects'
const ROOT_ID = fakeRootId(ROOT)
const REPO = { rootId: ROOT_ID, rel: '' }

async function renderGit(options: FakeApiOptions = {}) {
  setViewport(1280)
  const fake = fakeApi({ layout: { ...DEFAULT_LAYOUT, rightTab: 'git' }, ...options })
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByRole('heading', { name: 'Workspace chat' })
  await screen.findByRole('heading', { name: 'Git' })
  return { ...fake, user }
}

const row = (name: RegExp) => screen.getByRole('button', { name })

describe('Git tab: changes', () => {
  it('shows the branch, ahead/behind and the changed files grouped by area', async () => {
    const { api } = await renderGit()
    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.getByText('2 ahead, 1 behind origin/main')).toBeTruthy()
    for (const heading of ['Staged', 'Changes', 'Untracked'])
      expect(screen.getByRole('heading', { name: new RegExp(`^${heading}`) })).toBeTruthy()
    expect(row(/^new\.ts.*Added, staged, 12 added, 0 removed/)).toBeTruthy()
    expect(row(/^guide\.md.*Renamed, staged, from docs\/old\.md/)).toBeTruthy()
    expect(row(/^App\.tsx.*Modified, changes/)).toBeTruthy()
    expect(row(/^todo\.md.*Untracked/)).toBeTruthy()
    expect(api.git.watch).toHaveBeenCalledWith([REPO])
    const tab = screen.getByRole('tab', { name: /Changes/ })
    expect(
      within(tab).getByText(String(FAKE_GIT_STATUS.ok && FAKE_GIT_STATUS.changes.length)),
    ).toBeTruthy()
  })

  it('opens a file’s diff as plain text and goes back', async () => {
    const html = '<img src=x onerror=alert(1)>'
    const { api, user } = await renderGit({
      git: {
        diff: () => ({ ok: true, kind: 'text', diff: `@@ -1 +1 @@\n-a\n+${html}`, redacted: true }),
      },
    })
    await user.click(await screen.findByRole('button', { name: /^App\.tsx/ }))
    const diff = await screen.findByRole('region', { name: 'Diff of src/App.tsx' })
    expect(api.git.diff).toHaveBeenCalledWith({ repo: REPO, area: 'unstaged', path: 'src/App.tsx' })
    expect(within(diff).getByText(`+${html}`)).toBeTruthy()
    expect(diff.querySelector('img')).toBeNull()
    expect(within(diff).getByText(/look like secrets are hidden/)).toBeTruthy()
    await user.click(within(diff).getByRole('button', { name: '← Changes' }))
    expect(await screen.findByRole('button', { name: /^App\.tsx/ })).toBeTruthy()
  })

  it('asks for a renamed file’s diff with its old path', async () => {
    const { api, user } = await renderGit()
    await user.click(await screen.findByRole('button', { name: /^guide\.md/ }))
    await waitFor(() => {
      expect(api.git.diff).toHaveBeenCalledWith({
        repo: REPO,
        area: 'staged',
        path: 'docs/guide.md',
        oldPath: 'docs/old.md',
      })
    })
  })

  it('shows a secret file by name and status only and never references it', async () => {
    const { api, user } = await renderGit({
      git: { diff: () => ({ ok: true, kind: 'hidden', reason: 'A secrets file.' }) },
    })
    const secret = await screen.findByRole('button', { name: /^\.env.*contents hidden/ })
    const ref = screen.getByRole('button', { name: 'Insert reference to .env into chat' })
    expect(ref.getAttribute('aria-disabled')).toBe('true')
    await user.click(ref)
    expect(api.files.reference).not.toHaveBeenCalled()
    await user.click(secret)
    expect(await screen.findByText('Contents hidden: A secrets file.')).toBeTruthy()
  })

  it('inserts a reference to a changed file into the message box', async () => {
    const { api, user } = await renderGit()
    await user.click(
      await screen.findByRole('button', { name: 'Insert reference to src/App.tsx into chat' }),
    )
    expect(api.files.reference).toHaveBeenCalledWith({ rootId: ROOT_ID, rel: 'src/App.tsx' })
    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).value).toContain(
        '@"C:\\Users\\me\\Projects\\src\\App.tsx"',
      )
    })
    expect(
      screen
        .getByRole('button', { name: 'Insert reference to old.txt into chat' })
        .getAttribute('aria-disabled'),
    ).toBe('true')
  })

  it('shows binary, too-large and empty diffs as messages', async () => {
    for (const [kind, text] of [
      ['binary', /Binary file changed/],
      ['too-large', /Diff too large/],
      ['empty', /No line changes/],
    ] as const) {
      const { user, unmount } = await renderGitUnmountable({
        git: { diff: () => ({ ok: true, kind }) },
      })
      await user.click(await screen.findByRole('button', { name: /^App\.tsx/ }))
      expect(await screen.findByText(text)).toBeTruthy()
      unmount()
    }
  })

  it('refreshes when main says the repository changed', async () => {
    const { api, pushGitChanged } = await renderGit()
    await screen.findByRole('button', { name: /^App\.tsx/ })
    const before = api.git.status.mock.calls.length
    act(() => {
      pushGitChanged(REPO)
    })
    await waitFor(() => {
      expect(api.git.status.mock.calls.length).toBe(before + 1)
    })
  })
})

async function renderGitUnmountable(options: FakeApiOptions) {
  setViewport(1280)
  const fake = fakeApi({ layout: { ...DEFAULT_LAYOUT, rightTab: 'git' }, ...options })
  const user = userEvent.setup()
  const view = render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByRole('heading', { name: 'Git' })
  return { ...fake, user, unmount: view.unmount }
}

describe('Git tab: commits', () => {
  it('lists commits with untrusted text revealed and loads more', async () => {
    const { api, user } = await renderGit({
      git: {
        log: {
          ok: true,
          commits: [
            {
              hash: 'h1',
              short: 'h1h1h1h',
              author: 'Eve',
              date: Date.now() - 3 * 86_400_000,
              subject: 'fix \u202Etxt.exe',
              merge: false,
            },
          ],
          more: true,
        },
      },
    })
    await user.click(await screen.findByRole('tab', { name: 'Commits' }))
    const list = await screen.findByRole('list', { name: 'Recent commits' })
    expect(within(list).getByText('h1h1h1h')).toBeTruthy()
    expect(within(list).getByText('3 days ago')).toBeTruthy()
    expect(within(list).getByText('⟨U+202E⟩')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Load more commits' }))
    expect(api.git.log).toHaveBeenLastCalledWith({ repo: REPO, skip: 1 })
  })

  it('moves between views with the arrow keys', async () => {
    const { user } = await renderGit()
    ;(await screen.findByRole('tab', { name: /Changes/ })).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Commits' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Commits' }))
  })
})

describe('Git tab: degraded states', () => {
  it('offers to install git when it is missing', async () => {
    const { api, user } = await renderGit({ git: { overview: { git: 'missing' } } })
    expect(await screen.findByText('Git is not installed')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Install Git for Windows' }))
    expect(api.git.openInstallPage).toHaveBeenCalledWith()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(api.git.overview).toHaveBeenCalledTimes(2)
    expect(api.git.status).not.toHaveBeenCalled()
  })

  it('says when a folder is not a repository', async () => {
    await renderGit({
      git: {
        overview: {
          git: 'found',
          version: '2.45.0',
          folders: [{ rootId: ROOT_ID, name: 'Projects', path: ROOT, repos: [] }],
        },
      },
    })
    expect(await screen.findByText('This folder is not a git repository.')).toBeTruthy()
  })

  it('explains a refused repository and runs nothing in it', async () => {
    const { api } = await renderGit({
      git: {
        overview: {
          git: 'found',
          version: '2.45.0',
          folders: [
            {
              rootId: ROOT_ID,
              name: 'Projects',
              path: ROOT,
              repos: [
                {
                  rootId: ROOT_ID,
                  rel: '',
                  name: 'Projects',
                  path: ROOT,
                  kind: 'refused',
                  reason: 'Its git folder is outside the granted folders.',
                },
              ],
            },
          ],
        },
      },
    })
    expect(await screen.findByText('Its git folder is outside the granted folders.')).toBeTruthy()
    expect(api.git.status).not.toHaveBeenCalled()
  })

  it('shows a detached HEAD, a repository with no commits and a clean tree', async () => {
    await renderGitUnmountable({
      git: {
        status: { ok: true, branch: { head: null, oid: 'abcdef1234567' }, changes: [], more: 0 },
      },
    }).then(async ({ unmount }) => {
      expect(await screen.findByText('Detached at abcdef1')).toBeTruthy()
      expect(screen.getByText(/working tree is clean/)).toBeTruthy()
      unmount()
    })
    const { user } = await renderGitUnmountable({
      git: {
        status: { ok: true, branch: { head: 'main', oid: null }, changes: [], more: 0 },
        log: { ok: true, commits: [], more: false },
      },
    })
    expect(await screen.findByText('main (no commits yet)')).toBeTruthy()
    await user.click(await screen.findByRole('tab', { name: 'Commits' }))
    expect(await screen.findByText('No commits yet.')).toBeTruthy()
  })

  it('shows a git failure as an alert', async () => {
    await renderGit({
      git: { status: { ok: false, code: 'failed', reason: 'Git took too long to answer.' } },
    })
    expect((await screen.findByRole('alert')).textContent).toBe('Git took too long to answer.')
  })

  it('says when no folders are granted', async () => {
    await renderGit({ grants: { roots: [], loadError: null } })
    expect(await screen.findByText('No folders granted')).toBeTruthy()
  })
})
