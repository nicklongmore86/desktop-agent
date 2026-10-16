import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationSummary, HistoryState } from '../../shared/ipc'
import type { Project, ProviderChat } from '../../shared/ipc-projects'
import { ApiContext } from './api'
import { App } from './App'
import { fakeApi, type FakeApiOptions } from './test/fake-api'

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const X = '99999999-9999-4999-8999-999999999999'
const FORK_ID = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
const NEW_PROJECT_ID = 'abababab-abab-4bab-8bab-abababababab'
const TAXES = '11111111-1111-4111-8111-111111111111'
const GARDEN = '22222222-2222-4222-8222-222222222222'

const chat = (id: string, title: string, age: number, extra: object = {}): ConversationSummary => ({
  id,
  title,
  createdAt: now - age,
  updatedAt: now - age,
  ...extra,
})
const history: HistoryState = {
  activeId: A,
  conversations: [
    chat(A, 'Plan the release', 0),
    chat(B, 'Fix the flaky test', 3 * DAY, { pinnedAt: now - DAY }),
    chat(C, 'Reconcile receipts', DAY, { projectId: TAXES }),
    chat(D, 'Old notes', 30 * DAY, { archivedAt: now }),
  ],
}
const projects: Project[] = [
  { id: TAXES, name: 'Taxes', icon: '📊' },
  { id: GARDEN, name: 'Garden', icon: null },
]
const others: ProviderChat[] = [
  {
    ...chat(X, 'Estimate the tax bill', 2 * DAY, { projectId: TAXES }),
    provider: 'codex-subscription',
  },
]
const own = (id: string) => ({ provider: 'anthropic-api', id })

afterEach(() => {
  localStorage.clear()
})

async function renderApp(options: FakeApiOptions = {}) {
  const fake = fakeApi({
    history,
    projects,
    others,
    chat: {
      items: [
        { kind: 'user', id: 'h0.0', text: 'First prompt' },
        { kind: 'assistant', id: 'h1.0', text: 'Reply' },
        { kind: 'user', id: 'h2.0', text: 'Second prompt' },
      ],
      running: false,
      loadError: null,
    },
    ...options,
  })
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByText('v0.1.0')
  await within(sidebar()).findByRole('button', { name: 'Taxes' })
  return { ...fake, user }
}

const sidebar = () => screen.getByRole('complementary', { name: 'Conversations' })
const nav = () => within(sidebar()).getByRole('navigation', { name: 'Chats' })
const region = (name: string) => within(nav()).getByRole('region', { name })
const row = (title: string) => within(nav()).getByRole('button', { name: title })
const item = (title: string) => row(title).closest('li') as HTMLElement
const folder = (name: string) =>
  within(region('Projects')).getByRole('button', { name }).closest('li') as HTMLElement

describe('chat list sections', () => {
  it('shows Pinned, Projects with their chats (any provider) and the rest; archived are hidden', async () => {
    await renderApp()
    expect(within(region('Pinned')).getByText('Fix the flaky test')).toBeTruthy()
    const taxes = folder('Taxes')
    expect(within(taxes).getByText('Reconcile receipts')).toBeTruthy()
    expect(within(taxes).getByText('Estimate the tax bill')).toBeTruthy()
    // Another provider's chat says so, and says opening it switches provider.
    expect(within(taxes).getByText('Codex')).toBeTruthy()
    expect(row('Estimate the tax bill').title).toContain('switches provider')
    expect(within(region('Chats')).getByText('Plan the release')).toBeTruthy()
    expect(within(nav()).queryByText('Old notes')).toBeNull()
  })

  it("opens another provider's chat through a provider switch", async () => {
    const { api, user } = await renderApp()
    await user.click(row('Estimate the tax bill'))
    expect(api.chats.open).toHaveBeenCalledWith({ provider: 'codex-subscription', id: X })
    expect(api.chat.open).not.toHaveBeenCalled()
    expect(await screen.findByText('Codex · ChatGPT', { selector: '.app-header *' })).toBeTruthy()
  })

  it('collapses sections and projects, and remembers it', async () => {
    const { user } = await renderApp()
    const toggle = within(region('Pinned')).getByRole('button', { name: 'Pinned' })
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(nav()).queryByText('Fix the flaky test')).toBeNull()
    const taxes = within(region('Projects')).getByRole('button', { name: 'Taxes' })
    taxes.focus()
    await user.keyboard('{ArrowLeft}')
    expect(taxes.getAttribute('aria-expanded')).toBe('false')
    expect(within(nav()).queryByText('Reconcile receipts')).toBeNull()
    expect(JSON.parse(localStorage.getItem('desktop-agent:sidebar-sections') ?? '[]')).toEqual([
      'pinned',
    ])
    expect(JSON.parse(localStorage.getItem('desktop-agent:collapsed-projects') ?? '[]')).toEqual([
      TAXES,
    ])
  })
})

describe('chat menu', () => {
  it('pins by keyboard: Shift+F10 opens the menu on its first item', async () => {
    const { api, user } = await renderApp()
    row('Plan the release').focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menu = screen.getByRole('menu', { name: 'Options for Plan the release' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Pin' }))
    await user.keyboard('{Enter}')
    expect(api.chats.pin).toHaveBeenCalledWith(own(A), true)
    expect(await within(region('Pinned')).findByText('Plan the release')).toBeTruthy()
  })

  it('unpins with an Undo', async () => {
    const { api, user } = await renderApp()
    await user.click(within(nav()).getByRole('button', { name: 'Options for Fix the flaky test' }))
    await user.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    expect(api.chats.pin).toHaveBeenCalledWith(own(B), false)
    const toast = await screen.findByText(/Unpinned “Fix the flaky test”/)
    await user.click(
      within(toast.closest('.undo-toast') as HTMLElement).getByRole('button', { name: 'Undo' }),
    )
    expect(api.chats.pin).toHaveBeenLastCalledWith(own(B), true)
    expect(await within(region('Pinned')).findByText('Fix the flaky test')).toBeTruthy()
  })

  it('moves to a project through the submenu; Escape backs out one level at a time', async () => {
    const { api, user, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Working' })
    })
    const more = within(nav()).getByRole('button', { name: 'Options for Plan the release' })
    await user.click(more)
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(document.activeElement?.textContent).toContain('Move to project')
    await user.keyboard('{ArrowRight}')
    const sub = screen.getByRole('menu', { name: 'Move to project' })
    expect(
      within(sub)
        .getAllByRole('menuitem')
        .map((el) => el.textContent),
    ).toEqual(['‹ Move to project', '📊 Taxes', 'Garden', 'New project…'])
    await user.keyboard('{Escape}')
    expect(screen.getByRole('menu', { name: 'Options for Plan the release' })).toBeTruthy()
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain('Move to project')
    })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(api.chat.stop).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(document.activeElement).toBe(more)
    })

    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: 'Move to project' }))
    await user.click(screen.getByRole('menuitem', { name: 'Garden' }))
    expect(api.chats.move).toHaveBeenCalledWith(own(A), GARDEN)
    expect(await within(folder('Garden')).findByText('Plan the release')).toBeTruthy()
    // Undo puts it back where it was.
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(api.chats.move).toHaveBeenLastCalledWith(own(A), null)
  })

  it('removes from a project, and offers Remove only for a filed chat', async () => {
    const { api, user } = await renderApp()
    await user.click(within(nav()).getByRole('button', { name: 'Options for Reconcile receipts' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move to project' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove from project' }))
    expect(api.chats.move).toHaveBeenCalledWith(own(C), null)
  })

  it('files a chat in a new project made from the menu', async () => {
    const { api, user } = await renderApp()
    await user.click(within(nav()).getByRole('button', { name: 'Options for Plan the release' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move to project' }))
    await user.click(screen.getByRole('menuitem', { name: 'New project…' }))
    const dialog = screen.getByRole('dialog', { name: 'New project' })
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Name' }))
    await user.keyboard('Trip{Enter}')
    expect(api.projects.create).toHaveBeenCalledWith('Trip', null)
    await waitFor(() => {
      expect(api.chats.move).toHaveBeenCalledWith(own(A), NEW_PROJECT_ID)
    })
  })

  it('archives with an Undo; the Archived filter lists and restores', async () => {
    const { api, user } = await renderApp()
    await user.click(within(nav()).getByRole('button', { name: 'Options for Plan the release' }))
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(api.chats.archive).toHaveBeenCalledWith(own(A), true)
    await waitFor(() => {
      expect(within(nav()).queryByText('Plan the release')).toBeNull()
    })
    expect(screen.getByText(/Archived “Plan the release”/)).toBeTruthy()
    const filter = within(sidebar()).getByRole('button', { name: /^Archived/ })
    await user.click(filter)
    expect(filter.getAttribute('aria-pressed')).toBe('true')
    const archived = region('Archived')
    expect(within(archived).getByText('Plan the release')).toBeTruthy()
    expect(within(archived).getByText('Old notes')).toBeTruthy()
    await user.click(within(nav()).getByRole('button', { name: 'Options for Old notes' }))
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Restore',
      'Rename',
      'Delete…',
    ])
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }))
    expect(api.chats.archive).toHaveBeenCalledWith(own(D), false)
  })

  it("deletes with Delete after confirming; another provider's chat through its own call", async () => {
    const { api, user } = await renderApp()
    row('Plan the release').focus()
    await user.keyboard('{Delete}')
    const confirm = screen.getByRole('alertdialog', { name: 'Delete chat?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    expect(api.chat.remove).toHaveBeenCalledWith(A)
    row('Estimate the tax bill').focus()
    await user.keyboard('{Delete}')
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Delete chat?' })).getByRole('button', {
        name: 'Delete',
      }),
    )
    expect(api.chats.remove).toHaveBeenCalledWith({ provider: 'codex-subscription', id: X })
  })

  it('keeps disabled items in arrow order, saying why', async () => {
    const { user, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Working' })
    })
    await user.click(within(nav()).getByRole('button', { name: 'Options for Plan the release' }))
    const fork = screen.getByRole('menuitem', { name: 'Fork…' })
    expect(fork.getAttribute('aria-disabled')).toBe('true')
    expect(fork.title).toBe('Wait for the reply to finish, or stop it.')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(fork)
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog', { name: 'Fork chat' })).toBeNull()
  })
})

describe('fork', () => {
  it('says what is copied, forks the open chat from a prompt and opens the fork', async () => {
    const { api, user } = await renderApp()
    await user.click(within(nav()).getByRole('button', { name: 'Options for Plan the release' }))
    await user.click(screen.getByRole('menuitem', { name: 'Fork…' }))
    const dialog = screen.getByRole('dialog', { name: 'Fork chat' })
    expect(dialog.textContent).toContain('keeps the full conversation')
    expect(dialog.textContent).toContain('Approvals are not copied')
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Fork' }))
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Copy' }), '1')
    expect(dialog.textContent).toContain('the first 1 prompt')
    await user.click(within(dialog).getByRole('button', { name: 'Fork' }))
    expect(api.chats.fork).toHaveBeenCalledWith(own(A), 1)
    await waitFor(() => {
      expect(api.chat.open).toHaveBeenCalledWith(FORK_ID)
    })
  })

  it('forks another chat whole', async () => {
    const { api, user } = await renderApp()
    await user.click(within(nav()).getByRole('button', { name: 'Options for Reconcile receipts' }))
    await user.click(screen.getByRole('menuitem', { name: 'Fork…' }))
    const dialog = screen.getByRole('dialog', { name: 'Fork chat' })
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    await user.keyboard('{Enter}')
    expect(api.chats.fork).toHaveBeenCalledWith(own(C), null)
  })
})

describe('projects', () => {
  it('creates from +, renames, reorders and deletes from the folder menu', async () => {
    const { api, user } = await renderApp()
    await user.click(within(region('Projects')).getByRole('button', { name: 'New project' }))
    const dialog = screen.getByRole('dialog', { name: 'New project' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Trip')
    await user.click(within(dialog).getByRole('radio', { name: '🚀' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(api.projects.create).toHaveBeenCalledWith('Trip', '🚀')
    expect(await within(region('Projects')).findByRole('button', { name: 'Trip' })).toBeTruthy()

    await user.click(within(nav()).getByRole('button', { name: 'Options for project Garden' }))
    const items = screen.getAllByRole('menuitem')
    expect(items.map((el) => [el.textContent, el.getAttribute('aria-disabled')])).toEqual([
      ['Rename project…', null],
      ['Move up', null],
      ['Move down', null],
      ['Move to top', null],
      ['Move to bottom', null],
      ['Delete project…', null],
    ])
    await user.click(screen.getByRole('menuitem', { name: 'Move to top' }))
    expect(api.projects.move).toHaveBeenCalledWith(GARDEN, 'top')

    await user.click(within(nav()).getByRole('button', { name: 'Options for project Taxes' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete project…' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Delete project?' })
    expect(confirm.textContent).toContain('Its 2 chats are kept')
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
    await user.click(within(confirm).getByRole('button', { name: 'Delete project' }))
    expect(api.projects.remove).toHaveBeenCalledWith(TAXES)
    expect(await within(region('Chats')).findByText('Reconcile receipts')).toBeTruthy()
  })

  it('waits for an approval: the dialog hides, shortcuts wait, Escape cancels only the dialog', async () => {
    const { api, user, pushApproval, pushChat } = await renderApp()
    await user.click(within(region('Projects')).getByRole('button', { name: 'New project' }))
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy()
    await user.keyboard('{Control>}n{/Control}')
    expect(api.chat.newChat).not.toHaveBeenCalled()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Go' })
      pushApproval({
        id: 'ap1',
        runId: 'r1',
        toolUseId: 't1',
        tool: 'run_shell',
        kind: 'shell',
        summary: 'Run ls',
        detail: 'cwd: C:\\x\nshell: cmd\n\nls',
      })
    })
    expect(screen.queryByRole('dialog', { name: 'New project' })).toBeNull()
    const approval = screen.getByRole('alertdialog', { name: /Approve/ })
    await user.click(within(approval).getByRole('button', { name: 'Deny' }))
    act(() => {
      pushChat({ type: 'approval_closed', approvalId: 'ap1', approved: false })
    })
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Name' }))
    })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'New project' })).toBeNull()
    expect(api.chat.stop).not.toHaveBeenCalled()
  })
})

describe('drag and drop', () => {
  const drag = (from: HTMLElement) => {
    const dataTransfer = { setData: () => {}, effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(from, { dataTransfer })
    return dataTransfer
  }

  it('drops a chat on a project, on Pinned and back on Chats', async () => {
    const { api } = await renderApp()
    let data = drag(item('Plan the release'))
    const garden = folder('Garden')
    expect(garden.getAttribute('data-drop')).toBe('can')
    expect(within(region('Pinned')).getByText('Fix the flaky test')).toBeTruthy()
    fireEvent.dragOver(garden, { dataTransfer: data })
    expect(garden.getAttribute('data-drop')).toBe('over')
    fireEvent.drop(garden, { dataTransfer: data })
    await waitFor(() => {
      expect(api.chats.move).toHaveBeenCalledWith(own(A), GARDEN)
    })

    data = drag(item('Reconcile receipts'))
    fireEvent.dragOver(region('Pinned'), { dataTransfer: data })
    fireEvent.drop(region('Pinned'), { dataTransfer: data })
    await waitFor(() => {
      expect(api.chats.pin).toHaveBeenCalledWith(own(C), true)
    })

    data = drag(item('Fix the flaky test'))
    expect(within(region('Chats')).getByText('Drop here to remove from project')).toBeTruthy()
    fireEvent.dragOver(region('Chats'), { dataTransfer: data })
    fireEvent.drop(region('Chats'), { dataTransfer: data })
    await waitFor(() => {
      expect(api.chats.pin).toHaveBeenCalledWith(own(B), false)
    })
  })

  it('ignores drags from elsewhere and drops that change nothing', async () => {
    const { api } = await renderApp()
    const garden = folder('Garden')
    // From another app: no drag started here, so nothing accepts it.
    const outside = fireEvent.dragOver(garden, { dataTransfer: { dropEffect: '' } })
    expect(outside).toBe(true)
    fireEvent.drop(garden, { dataTransfer: {} })
    // Onto its own project.
    const data = drag(item('Reconcile receipts'))
    const taxes = folder('Taxes')
    expect(taxes.getAttribute('data-drop')).toBeNull()
    expect(fireEvent.dragOver(taxes, { dataTransfer: data })).toBe(true)
    fireEvent.drop(taxes, { dataTransfer: data })
    fireEvent.dragEnd(item('Reconcile receipts'))
    expect(api.chats.move).not.toHaveBeenCalled()
    expect(api.chats.pin).not.toHaveBeenCalled()
  })
})
