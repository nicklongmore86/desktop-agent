import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAYOUT, type LayoutPrefs } from '../../shared/ipc-layout'
import { ApiContext } from './api'
import { App } from './App'
import { LAYOUT_SAVE_DELAY } from './use-layout-prefs'
import { fakeApi, type FakeApiOptions } from './test/fake-api'
import { setViewport } from './test/viewport'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const history = {
  activeId: A,
  conversations: [
    { id: A, title: 'Plan the release', createdAt: 2, updatedAt: 2 },
    { id: B, title: 'Old notes', createdAt: 1, updatedAt: 1 },
  ],
}

async function renderApp(width: number, options: FakeApiOptions = {}) {
  setViewport(width)
  const fake = fakeApi({ history, ...options })
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByRole('heading', { name: 'Workspace chat' })
  await waitFor(() => {
    expect(fake.api.layout.get).toHaveBeenCalled()
  })
  // Let the saved layout land.
  await act(async () => {
    await Promise.resolve()
  })
  return { ...fake, user }
}

const left = () => screen.getByRole('complementary', { name: 'Conversations', hidden: true })
const right = () => screen.getByRole('complementary', { name: 'Workspace', hidden: true })
const leftToggle = () => screen.getByRole('button', { name: 'Chats sidebar' })
const rightToggle = () => screen.getByRole('button', { name: 'Workspace panel' })
const isOpen = (pane: HTMLElement) => pane.getAttribute('data-open') === 'true'
const isInert = (pane: HTMLElement) => pane.hasAttribute('inert')
const ctrlAlt = (code: 'BracketLeft' | 'BracketRight', init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { ctrlKey: true, altKey: true, code, ...init })

describe('docked panes (wide window)', () => {
  it('shows both panes, with the Folder access block in the Workspace panel', async () => {
    await renderApp(1280)
    expect(isOpen(left())).toBe(true)
    expect(isOpen(right())).toBe(true)
    expect(isInert(left())).toBe(false)
    const panel = within(right())
    expect(panel.getByRole('tab', { name: 'Files', selected: true })).toBeTruthy()
    expect(panel.getByRole('heading', { name: 'Folder access' })).toBeTruthy()
    expect(panel.getByText('C:\\Users\\me\\Projects')).toBeTruthy()
    // The old left-sidebar block is gone.
    expect(within(left()).queryByText('Folder access')).toBeNull()
    expect(leftToggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('collapses and expands each pane from its header button: width 0 and inert', async () => {
    const { user } = await renderApp(1280)
    await user.click(leftToggle())
    expect(isOpen(left())).toBe(false)
    expect(isInert(left())).toBe(true)
    expect(leftToggle().getAttribute('aria-expanded')).toBe('false')
    expect(isOpen(right())).toBe(true)
    await user.click(rightToggle())
    expect(isInert(right())).toBe(true)
    // Preferences stays reachable with both collapsed.
    expect(screen.getByRole('button', { name: 'Preferences' })).toBeTruthy()
    await user.click(leftToggle())
    await user.click(rightToggle())
    expect(isOpen(left()) && isOpen(right())).toBe(true)
    expect(isInert(left()) || isInert(right())).toBe(false)
  })

  it('toggles with Ctrl+Alt+[ and ], and not on repeat or AltGraph', async () => {
    await renderApp(1280)
    ctrlAlt('BracketLeft')
    expect(isOpen(left())).toBe(false)
    ctrlAlt('BracketRight')
    expect(isOpen(right())).toBe(false)
    ctrlAlt('BracketLeft', { repeat: true })
    ctrlAlt('BracketLeft', { modifierAltGraph: true })
    expect(isOpen(left())).toBe(false)
    ctrlAlt('BracketLeft')
    ctrlAlt('BracketRight')
    expect(isOpen(left()) && isOpen(right())).toBe(true)
  })

  it('leaves the shortcuts off while an approval is open', async () => {
    const { pushApproval } = await renderApp(1280)
    act(() => {
      pushApproval({
        id: 'ap1',
        runId: 'r',
        toolUseId: null,
        tool: 'run_shell',
        kind: 'shell',
        summary: 'Run ls',
        detail: 'ls',
      })
    })
    ctrlAlt('BracketLeft')
    ctrlAlt('BracketRight')
    expect(isOpen(left()) && isOpen(right())).toBe(true)
  })

  it('leaves the shortcuts off while Settings is open', async () => {
    const { user } = await renderApp(1280)
    await user.click(screen.getByRole('button', { name: 'Preferences' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    ctrlAlt('BracketLeft')
    expect(isOpen(left())).toBe(true)
    // The panes behind a dialog are inert.
    expect(isInert(left()) && isInert(right())).toBe(true)
  })

  it('switches tabs by click and arrow keys, and keeps the Git tab an empty host', async () => {
    const { user } = await renderApp(1280)
    const files = screen.getByRole('tab', { name: 'Files' })
    const git = screen.getByRole('tab', { name: 'Git' })
    expect(files.tabIndex).toBe(0)
    expect(git.tabIndex).toBe(-1)
    files.focus()
    await user.keyboard('{ArrowRight}')
    expect(git.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(git)
    expect(screen.getByRole('tabpanel', { name: 'Git' })).toBeTruthy()
    await user.keyboard('{Home}')
    expect(files.getAttribute('aria-selected')).toBe('true')
    await user.click(git)
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('workspace-tab-git')
  })
})

describe('Folder access in the Workspace panel', () => {
  it('adds and removes folders, and shows why a folder was refused', async () => {
    const { user, api } = await renderApp(1280)
    const panel = within(right())
    await user.click(panel.getByRole('button', { name: 'Add folder…' }))
    expect(api.grants.add).toHaveBeenCalledOnce()
    expect(await panel.findByText('D:\\Docs')).toBeTruthy()
    await user.click(panel.getByRole('button', { name: 'Remove D:\\Docs' }))
    expect(api.grants.remove).toHaveBeenCalledWith('D:\\Docs')
    await waitFor(() => {
      expect(panel.queryByText('D:\\Docs')).toBeNull()
    })

    api.grants.add.mockResolvedValueOnce({
      status: 'refused',
      reason: 'That folder is protected.',
      grants: { roots: ['C:\\Users\\me\\Projects'], loadError: null },
    })
    await user.click(panel.getByRole('button', { name: 'Add folder…' }))
    expect((await panel.findByRole('alert')).textContent).toBe('That folder is protected.')

    await user.click(panel.getByRole('button', { name: 'Manage folders' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
  })

  it('says when there are none', async () => {
    await renderApp(1280, { grants: { roots: [], loadError: null } })
    expect(within(right()).getByText('No folders granted')).toBeTruthy()
  })
})

describe('resizing', () => {
  const separator = (name: string) => screen.getByRole('separator', { name })

  it('exposes a focusable separator with its limits, and resizes with the keyboard', async () => {
    const { user, api } = await renderApp(1280)
    const bar = separator('Resize chats sidebar')
    expect(bar.tabIndex).toBe(0)
    expect(bar.getAttribute('aria-orientation')).toBe('vertical')
    expect(bar.getAttribute('aria-valuemin')).toBe('220')
    expect(bar.getAttribute('aria-valuemax')).toBe('512')
    expect(bar.getAttribute('aria-valuenow')).toBe('272')
    bar.focus()
    await user.keyboard('{ArrowRight}')
    expect(bar.getAttribute('aria-valuenow')).toBe('288')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(bar.getAttribute('aria-valuenow')).toBe('256')
    await user.keyboard('{Home}')
    expect(bar.getAttribute('aria-valuenow')).toBe('220')
    await user.keyboard('{ArrowLeft}')
    expect(bar.getAttribute('aria-valuenow')).toBe('220')
    await user.keyboard('{End}')
    expect(bar.getAttribute('aria-valuenow')).toBe('512')
    const root = document.querySelector<HTMLElement>('.app')
    expect(root?.style.getPropertyValue('--sidebar-width-left')).toBe('512px')

    // The right separator is mirrored: ArrowLeft grows the pane.
    const rbar = separator('Resize workspace panel')
    rbar.focus()
    const before = Number(rbar.getAttribute('aria-valuenow'))
    await user.keyboard('{ArrowLeft}')
    expect(Number(rbar.getAttribute('aria-valuenow'))).toBe(Math.min(before + 16, 1280 - 512 - 480))
    expect(api.layout.set).not.toHaveBeenCalled()
  })

  it('resizes by dragging, tracking the pointer outside the handle', async () => {
    await renderApp(1280)
    const bar = separator('Resize chats sidebar')
    fireEvent.pointerDown(bar, { button: 0, clientX: 272, pointerId: 1 })
    expect(document.querySelector('.app')?.hasAttribute('data-resizing')).toBe(true)
    fireEvent.pointerMove(bar, { clientX: 322, pointerId: 1 })
    expect(bar.getAttribute('aria-valuenow')).toBe('322')
    fireEvent.pointerMove(bar, { clientX: 5000, pointerId: 1 })
    expect(bar.getAttribute('aria-valuenow')).toBe('512')
    fireEvent.pointerMove(bar, { clientX: -5000, pointerId: 1 })
    expect(bar.getAttribute('aria-valuenow')).toBe('220')
    fireEvent.pointerUp(bar, { pointerId: 1 })
    expect(document.querySelector('.app')?.hasAttribute('data-resizing')).toBe(false)
    fireEvent.pointerMove(bar, { clientX: 400, pointerId: 1 })
    expect(bar.getAttribute('aria-valuenow')).toBe('220')

    // The right pane grows as the pointer moves left.
    const rbar = separator('Resize workspace panel')
    fireEvent.pointerDown(rbar, { button: 0, clientX: 900, pointerId: 2 })
    fireEvent.pointerMove(rbar, { clientX: 860, pointerId: 2 })
    expect(rbar.getAttribute('aria-valuenow')).toBe('360')
    fireEvent.pointerUp(rbar, { pointerId: 2 })
  })

  it('resets to the default on double-click', async () => {
    const { user } = await renderApp(1280)
    const bar = separator('Resize chats sidebar')
    bar.focus()
    await user.keyboard('{End}')
    await user.dblClick(bar)
    expect(bar.getAttribute('aria-valuenow')).toBe('272')
  })

  it('has no separator for a collapsed pane', async () => {
    const { user } = await renderApp(1280)
    await user.click(leftToggle())
    expect(screen.queryByRole('separator', { name: 'Resize chats sidebar' })).toBeNull()
    expect(screen.getByRole('separator', { name: 'Resize workspace panel' })).toBeTruthy()
  })

  it('keeps the chat column at 480px: the right pane shrinks, then steps aside', async () => {
    const { user } = await renderApp(1100)
    // 1100 - 272 - 480 leaves 348, so a 500px request is held at 348.
    const rbar = separator('Resize workspace panel')
    expect(rbar.getAttribute('aria-valuemax')).toBe('348')
    // A wider left pane takes the room: the right one becomes a drawer, still "open" in prefs.
    separator('Resize chats sidebar').focus()
    await user.keyboard('{End}')
    expect(screen.queryByRole('separator', { name: 'Resize workspace panel' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Workspace' })).toBeNull()
    expect(rightToggle().getAttribute('aria-expanded')).toBe('false')
    await user.click(rightToggle())
    expect(screen.getByRole('dialog', { name: 'Workspace' })).toBeTruthy()
  })
})

describe('layout persistence', () => {
  it('loads the saved layout without animating into it', async () => {
    const saved: LayoutPrefs = {
      ...DEFAULT_LAYOUT,
      leftOpen: false,
      rightWidth: 400,
      rightTab: 'git',
    }
    await renderApp(1280, { layout: saved })
    expect(isOpen(left())).toBe(false)
    expect(isInert(left())).toBe(true)
    expect(
      screen
        .getByRole('separator', { name: 'Resize workspace panel' })
        .getAttribute('aria-valuenow'),
    ).toBe('400')
    expect(screen.getByRole('tab', { name: 'Git' }).getAttribute('aria-selected')).toBe('true')
  })

  it('saves changes debounced as one write, and never a path', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { api, user } = await renderApp(1280)
      const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
      await user.click(leftToggle())
      await advance(LAYOUT_SAVE_DELAY - 100)
      await user.click(screen.getByRole('tab', { name: 'Git' }))
      await advance(LAYOUT_SAVE_DELAY - 100)
      expect(api.layout.set).not.toHaveBeenCalled()
      await advance(200)
      expect(api.layout.set).toHaveBeenCalledOnce()
      const saved = api.layout.set.mock.calls[0]?.[0]
      expect(saved).toEqual({ ...DEFAULT_LAYOUT, leftOpen: false, rightTab: 'git' })
      expect(JSON.stringify(saved)).not.toContain('Projects')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a pending save when the page goes away', async () => {
    const { api, user } = await renderApp(1280)
    await user.click(rightToggle())
    expect(api.layout.set).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(api.layout.set).toHaveBeenCalledWith({ ...DEFAULT_LAYOUT, rightOpen: false })
  })

  it('does not save just by loading', async () => {
    const { api } = await renderApp(1280)
    await new Promise((done) => setTimeout(done, LAYOUT_SAVE_DELAY + 50))
    expect(api.layout.set).not.toHaveBeenCalled()
  })

  it('still works when the saved layout cannot be read', async () => {
    const fake = fakeApi({ history })
    fake.api.layout.get.mockRejectedValue(new Error('boom'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    setViewport(1280)
    render(
      <ApiContext value={fake.api}>
        <App />
      </ApiContext>,
    )
    await screen.findByRole('heading', { name: 'Workspace chat' })
    await waitFor(() => {
      expect(error).toHaveBeenCalled()
    })
    expect(isOpen(left())).toBe(true)
    error.mockRestore()
  })
})

describe('drawers (narrow windows)', () => {
  it.each([
    [1000, 'right'],
    [700, 'both'],
    [400, 'both'],
  ])('at %ipx the %s pane(s) are drawers, opened by the header buttons', async (width, which) => {
    const { user } = await renderApp(width)
    expect(screen.queryByRole('complementary', { name: 'Workspace' })).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize workspace panel' })).toBeNull()
    if (which === 'both')
      expect(screen.queryByRole('complementary', { name: 'Conversations' })).toBeNull()
    else expect(isOpen(left())).toBe(true)

    const toggle = rightToggle()
    expect(toggle.getAttribute('aria-haspopup')).toBe('dialog')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)
    const drawer = screen.getByRole('dialog', { name: 'Workspace' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe(drawer.id)
    expect(within(drawer).getByRole('tab', { name: 'Files' })).toBeTruthy()
    expect(within(drawer).getByText('C:\\Users\\me\\Projects')).toBeTruthy()
    // Focus moves into the drawer, and Escape closes it and returns focus to the opener.
    expect(document.activeElement).toBe(drawer)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Workspace' })).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('closes on the scrim and the close button', async () => {
    const { user } = await renderApp(400)
    await user.click(leftToggle())
    const scrim = document.querySelector('.shell-drawer-backdrop')
    expect(scrim).toBeTruthy()
    fireEvent.mouseDown(scrim as Element)
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(rightToggle())
    await user.click(screen.getByRole('button', { name: 'Close workspace' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows one drawer at a time', async () => {
    const { user } = await renderApp(400)
    await user.click(leftToggle())
    expect(screen.getByRole('dialog', { name: 'Chats' })).toBeTruthy()
    // Page behind the open drawer is inert; the shortcut still swaps drawers.
    expect(document.querySelector('main')?.hasAttribute('inert') ?? false).toBe(false)
    ctrlAlt('BracketRight')
    expect(screen.queryByRole('dialog', { name: 'Chats' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Workspace' })).toBeTruthy()
    ctrlAlt('BracketRight')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('traps Tab inside the drawer', async () => {
    const { user } = await renderApp(400)
    await user.click(rightToggle())
    const drawer = screen.getByRole('dialog', { name: 'Workspace' })
    const close = within(drawer).getByRole('button', { name: 'Close workspace' })
    await user.tab({ shift: true })
    expect(drawer.contains(document.activeElement)).toBe(true)
    // Cycle forward through everything focusable: never leaves.
    for (let i = 0; i < 12; i += 1) {
      await user.tab()
      expect(drawer.contains(document.activeElement)).toBe(true)
    }
    close.focus()
    await user.tab({ shift: true })
    expect(drawer.contains(document.activeElement)).toBe(true)
  })

  it('closes when the window crosses a breakpoint', async () => {
    const { user } = await renderApp(400)
    await user.click(leftToggle())
    expect(screen.getByRole('dialog', { name: 'Chats' })).toBeTruthy()
    act(() => {
      setViewport(700)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    // And it stays closed when the window goes back.
    act(() => {
      setViewport(400)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    // Within one bucket it stays open.
    await user.click(leftToggle())
    act(() => {
      setViewport(450)
    })
    expect(screen.getByRole('dialog', { name: 'Chats' })).toBeTruthy()
  })

  it('docks the pane again when the window widens, with the saved state', async () => {
    await renderApp(400)
    act(() => {
      setViewport(1280)
    })
    expect(isOpen(left())).toBe(true)
    expect(isOpen(right())).toBe(true)
  })

  it('choosing a chat in the left drawer opens it and closes the drawer', async () => {
    const { user, api } = await renderApp(400)
    await user.click(leftToggle())
    const drawer = screen.getByRole('dialog', { name: 'Chats' })
    await user.click(await within(drawer).findByRole('button', { name: 'Old notes' }))
    expect(api.chat.open).toHaveBeenCalledWith(B)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('New chat in the drawer closes it', async () => {
    const { user, api } = await renderApp(400)
    await user.click(leftToggle())
    await user.click(
      within(screen.getByRole('dialog', { name: 'Chats' })).getByRole('button', {
        name: 'New chat',
      }),
    )
    expect(api.chat.newChat).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has no horizontal overflow source: panes are not in the page at 400px', async () => {
    await renderApp(400)
    expect(document.querySelectorAll('.shell-pane')).toHaveLength(0)
  })
})

describe('approvals above the shell', () => {
  const approval = {
    id: 'ap1',
    runId: 'r',
    toolUseId: null,
    tool: 'run_shell',
    kind: 'shell' as const,
    summary: 'Run ls',
    detail: 'ls',
  }

  it('wins focus over an open drawer, hides it, and gives focus back after the answer', async () => {
    const { user, pushApproval, pushChat } = await renderApp(400)
    await user.click(leftToggle())
    const drawer = screen.getByRole('dialog', { name: 'Chats' })
    act(() => {
      pushApproval(approval)
    })
    const card = screen.getByRole('alertdialog', { name: /Approve/ })
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Deny' }))
    expect(drawer.closest('.shell-drawer-backdrop')?.hasAttribute('hidden')).toBe(true)
    await user.keyboard('{Escape}')
    act(() => {
      pushChat({ type: 'approval_closed', approvalId: 'ap1', approved: false })
    })
    // Escape denied the approval and did not close the drawer underneath.
    expect(screen.getByRole('dialog', { name: 'Chats' })).toBe(drawer)
    expect(drawer.closest('.shell-drawer-backdrop')?.hasAttribute('hidden')).toBe(false)
    expect(document.activeElement).toBe(drawer)
  })
})

describe('Escape order', () => {
  const approval = {
    id: 'ap1',
    runId: 'r',
    toolUseId: null,
    tool: 'run_shell',
    kind: 'shell' as const,
    summary: 'Run ls',
    detail: 'ls',
  }

  /** Approval (deny) > Settings (close) > drawer (close) > stop the running reply. */
  it('closes one layer per press: approval, then Settings, then the drawer, then stops the reply', async () => {
    const { user, api, pushChat, pushApproval } = await renderApp(400)
    act(() => {
      pushChat({ type: 'run_started', runId: 'r', text: 'Hello' })
    })
    await user.click(rightToggle())
    expect(screen.getByRole('dialog', { name: 'Workspace' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Manage folders' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    act(() => {
      pushApproval(approval)
    })
    expect(screen.getByRole('alertdialog', { name: /Approve/ })).toBeTruthy()

    // 1. Approval: denied. Nothing else changes.
    await user.keyboard('{Escape}')
    expect(api.approvals.respond).toHaveBeenCalledWith('ap1', false)
    act(() => {
      pushChat({ type: 'approval_closed', approvalId: 'ap1', approved: false })
    })
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(api.chat.stop).not.toHaveBeenCalled()

    // 2. Settings closes; the drawer under it stays.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Workspace' })).toBeTruthy()
    expect(api.chat.stop).not.toHaveBeenCalled()

    // 3. The drawer closes.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Workspace' })).toBeNull()
    expect(api.chat.stop).not.toHaveBeenCalled()

    // 4. Nothing open: Escape stops the running reply.
    await user.keyboard('{Escape}')
    expect(api.chat.stop).toHaveBeenCalledOnce()
  })

  it('a docked layout still lets Escape stop the reply (nothing to close)', async () => {
    const { user, api, pushChat } = await renderApp(1280)
    act(() => {
      pushChat({ type: 'run_started', runId: 'r', text: 'Hello' })
    })
    await user.keyboard('{Escape}')
    expect(api.chat.stop).toHaveBeenCalledOnce()
  })
})
