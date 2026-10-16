import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ConversationSummary, HistoryState } from '../../shared/ipc'
import { ApiContext } from './api'
import { App } from './App'
import { chatReducer, initialChatState } from './chat-state'
import { groupConversations } from './components/HistoryList'
import { fakeApi, type FakeApiOptions } from './test/fake-api'

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const chat = (id: string, title: string, age: number): ConversationSummary => ({
  id,
  title,
  createdAt: now - age,
  updatedAt: now - age,
})
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const history: HistoryState = {
  activeId: A,
  conversations: [
    chat(A, 'Plan the release', 0),
    chat(B, 'Fix the flaky test', 3 * DAY),
    chat(C, 'Old notes', 30 * DAY),
  ],
}

async function renderApp(options: FakeApiOptions = {}) {
  const fake = fakeApi({
    history,
    chat: {
      items: [{ kind: 'user', id: 'h0.0', text: 'Saved message' }],
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
  const first = (options.history ?? history).conversations[0]
  if (first) await screen.findByRole('button', { name: first.title })
  return { ...fake, user }
}

const sidebar = () => screen.getByRole('complementary', { name: 'Workspace' })
const item = (name: string) => within(sidebar()).getByRole('button', { name })

describe('groupConversations', () => {
  it('groups by local day: today, the 7 days before, older', () => {
    const noon = new Date(2026, 9, 16, 12).getTime()
    const at = (date: Date) => ({ ...chat(String(date.getTime()), 'x', 0), updatedAt: +date })
    const groups = groupConversations(
      [
        at(new Date(2026, 9, 16, 0, 0, 1)),
        at(new Date(2026, 9, 15, 23, 59)),
        at(new Date(2026, 9, 9, 0, 0)),
        at(new Date(2026, 9, 8, 23, 59)),
      ],
      noon,
    )
    expect(groups.map((g) => [g.label, g.conversations.length])).toEqual([
      ['Today', 1],
      ['Previous 7 days', 2],
      ['Older', 1],
    ])
    expect(groupConversations([], noon)).toEqual([])
  })
})

describe('chat history in the sidebar', () => {
  it('lists the chats in date groups with the open one marked', async () => {
    await renderApp()
    const nav = within(sidebar()).getByRole('navigation', { name: 'Chats' })
    expect(within(nav).getByRole('region', { name: 'Today' })).toBeTruthy()
    expect(
      within(within(nav).getByRole('region', { name: 'Previous 7 days' })).getByText(
        'Fix the flaky test',
      ),
    ).toBeTruthy()
    expect(within(within(nav).getByRole('region', { name: 'Older' })).getByText('Old notes'))
    expect(item('Plan the release').getAttribute('aria-current')).toBe('page')
    expect(item('Fix the flaky test').getAttribute('aria-current')).toBeNull()
  })

  it('renders titles as plain, isolated text', async () => {
    await renderApp({
      history: {
        activeId: null,
        conversations: [chat(A, '<img src=x onerror=alert(1)> **bold**', 0)],
      },
    })
    const button = item('<img src=x onerror=alert(1)> **bold**')
    expect(button.querySelector('img, strong')).toBeNull()
    expect(button.querySelector('bdi')?.textContent).toBe('<img src=x onerror=alert(1)> **bold**')
  })

  it('says when there are no saved chats', async () => {
    const fake = fakeApi()
    render(
      <ApiContext value={fake.api}>
        <App />
      </ApiContext>,
    )
    expect(await within(sidebar()).findByText('No saved chats yet')).toBeTruthy()
  })

  it('opens a chat like a switch: hides the old one and refuses sends until it loads', async () => {
    const { api, user } = await renderApp()
    let finish: () => void = () => {}
    api.chat.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({
              items: [{ kind: 'user', id: 'h0.0', text: 'Flaky test details' }],
              running: false,
              loadError: null,
              history: { ...history, activeId: B },
            })
          }
        }),
    )
    api.chat.load.mockResolvedValueOnce({
      items: [{ kind: 'user', id: 'h0.0', text: 'Flaky test details' }],
      running: false,
      loadError: null,
      history: { ...history, activeId: B },
    })
    await user.click(item('Fix the flaky test'))
    expect(api.chat.open).toHaveBeenCalledWith(B)
    expect(screen.queryByText('Saved message')).toBeNull()
    expect(screen.getByText('Opening chat…')).toBeTruthy()
    // Sends wait, and so do other chats and New chat.
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'too soon{Enter}')
    expect(api.chat.send).not.toHaveBeenCalled()
    await user.click(item('Old notes'))
    expect(api.chat.open).toHaveBeenCalledOnce()
    expect(within(sidebar()).getByRole('button', { name: 'New chat' })).toHaveProperty(
      'disabled',
      true,
    )

    await act(async () => {
      finish()
      await Promise.resolve()
    })
    expect(await screen.findByText('Flaky test details')).toBeTruthy()
    expect(item('Fix the flaky test').getAttribute('aria-current')).toBe('page')
  })

  it('does nothing when the open chat is clicked', async () => {
    const { api, user } = await renderApp()
    await user.click(item('Plan the release'))
    expect(api.chat.open).not.toHaveBeenCalled()
    expect(screen.getByText('Saved message')).toBeTruthy()
  })

  it('moves with the arrow keys and opens with Enter', async () => {
    const { api, user } = await renderApp()
    item('Plan the release').focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(item('Fix the flaky test'))
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(item('Old notes'))
    await user.keyboard('{ArrowUp}{Enter}')
    expect(api.chat.open).toHaveBeenCalledWith(B)
  })

  it('updates the list when main says it changed, but not mid-switch', async () => {
    const { pushChat } = await renderApp()
    act(() => {
      pushChat({
        type: 'history_changed',
        history: { activeId: A, conversations: [chat(A, 'Plan the release v2', 0)] },
      })
    })
    expect(item('Plan the release v2')).toBeTruthy()
    expect(within(sidebar()).queryByText('Old notes')).toBeNull()
  })

  it('renames with F2 or the menu; Enter saves and Escape cancels without stopping a reply', async () => {
    const { api, user, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Working' })
    })
    item('Fix the flaky test').focus()
    await user.keyboard('{F2}')
    const field = within(sidebar()).getByRole('textbox', { name: 'Chat name' })
    expect(document.activeElement).toBe(field)
    await user.keyboard('Nope{Escape}')
    expect(api.chat.rename).not.toHaveBeenCalled()
    expect(api.chat.stop).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(document.activeElement).toBe(item('Fix the flaky test'))
    })

    await user.click(within(sidebar()).getByRole('button', { name: 'Options for Old notes' }))
    const menu = within(sidebar()).getByRole('menu', { name: 'Options for Old notes' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Rename' }))
    await user.keyboard('{Enter}')
    const rename = within(sidebar()).getByRole('textbox', { name: 'Chat name' })
    await user.clear(rename)
    await user.type(rename, 'Archive{Enter}')
    expect(api.chat.rename).toHaveBeenCalledWith(C, 'Archive')
    expect(await within(sidebar()).findByRole('button', { name: 'Archive' })).toBeTruthy()
  })

  it('closes the menu with Escape, back on its button, without stopping a reply', async () => {
    const { api, user, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Working' })
    })
    const more = within(sidebar()).getByRole('button', { name: 'Options for Old notes' })
    await user.click(more)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toBe('Delete…')
    await user.keyboard('{Escape}')
    expect(within(sidebar()).queryByRole('menu')).toBeNull()
    expect(api.chat.stop).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(document.activeElement).toBe(more)
    })
  })

  it('asks before deleting; Cancel keeps the chat and returns focus', async () => {
    const { api, user } = await renderApp()
    const more = within(sidebar()).getByRole('button', { name: 'Options for Old notes' })
    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete chat?' })
    expect(within(dialog).getByText('Old notes')).toBeTruthy()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.chat.remove).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(more)
  })

  it('deletes another chat without touching the open one', async () => {
    const { api, user } = await renderApp()
    await user.click(within(sidebar()).getByRole('button', { name: 'Options for Old notes' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(api.chat.remove).toHaveBeenCalledWith(C)
    await waitFor(() => {
      expect(within(sidebar()).queryByText('Old notes')).toBeNull()
    })
    expect(api.chat.load).toHaveBeenCalledOnce()
    expect(screen.getByText('Saved message')).toBeTruthy()
  })

  it('deleting the open chat goes through the switch and leaves a new chat', async () => {
    const { api, user } = await renderApp()
    await user.click(
      within(sidebar()).getByRole('button', { name: 'Options for Plan the release' }),
    )
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(api.chat.remove).toHaveBeenCalledWith(A)
    await waitFor(() => {
      expect(within(sidebar()).queryByText('Plan the release')).toBeNull()
    })
    expect(screen.queryByText('Saved message')).toBeNull()
    expect(api.chat.load).toHaveBeenCalledTimes(2)
  })

  it('hides the delete confirmation while an approval is open, then brings it back', async () => {
    const { user, pushApproval, pushChat } = await renderApp()
    await user.click(within(sidebar()).getByRole('button', { name: 'Options for Old notes' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
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
    expect(screen.queryByRole('alertdialog', { name: 'Delete chat?' })).toBeNull()
    const approval = screen.getByRole('alertdialog', { name: /Approve/ })
    expect(document.activeElement).toBe(within(approval).getByRole('button', { name: 'Deny' }))
    act(() => {
      pushChat({ type: 'approval_closed', approvalId: 'ap1', approved: false })
    })
    const confirm = screen.getByRole('alertdialog', { name: 'Delete chat?' })
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
  })

  it('opens the list from the header on narrow windows', async () => {
    const { api, user } = await renderApp()
    const toggle = screen.getByRole('button', { name: 'Chats' })
    await user.click(toggle)
    const drawer = screen.getByRole('dialog', { name: 'Chats' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Chats' })).toBeNull()
    expect(document.activeElement).toBe(toggle)

    await user.click(toggle)
    await user.click(
      within(screen.getByRole('dialog', { name: 'Chats' })).getByRole('button', {
        name: 'Old notes',
      }),
    )
    expect(api.chat.open).toHaveBeenCalledWith(C)
    expect(screen.queryByRole('dialog', { name: 'Chats' })).toBeNull()
    expect(drawer.isConnected).toBe(false)
  })
})

describe('chat switches in the reducer', () => {
  const loaded = chatReducer(initialChatState, {
    type: 'loaded',
    state: { items: [], running: true, loadError: null, history },
  })

  it('keeps the list when opening another chat, and clears it for another provider', () => {
    expect(chatReducer(loaded, { type: 'switch_started', kind: 'chat' }).history).toBe(history)
    expect(chatReducer(loaded, { type: 'switch_started', kind: 'provider' }).history).toEqual({
      conversations: [],
      activeId: null,
    })
  })

  it('ignores list updates from before the switch, and takes the reset’s list', () => {
    const switching = chatReducer(loaded, { type: 'switch_started', kind: 'provider' })
    const stale = { conversations: [chat(B, 'old provider', 0)], activeId: B }
    expect(
      chatReducer(switching, { type: 'event', event: { type: 'history_changed', history: stale } }),
    ).toBe(switching)
    expect(chatReducer(switching, { type: 'history', history: stale })).toBe(switching)
    const fresh = { conversations: [chat(C, 'new provider', 0)], activeId: C }
    const done = chatReducer(switching, {
      type: 'event',
      event: {
        type: 'conversation_reset',
        state: { items: [], running: false, loadError: null, history: fresh },
      },
    })
    expect(done).toMatchObject({ switching: false, switchKind: null, history: fresh })
  })
})
