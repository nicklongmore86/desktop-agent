import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApprovalPrompt } from '../../shared/ipc'
import { ApiContext } from './api'
import { App } from './App'
import { ApprovalCard } from './components/ApprovalCard'
import { fakeApi, type FakeApiOptions } from './test/fake-api'
import { setViewport } from './test/viewport'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROOT = 'C:\\Users\\me\\Projects'

async function renderApp(options: FakeApiOptions = {}) {
  const fake = fakeApi(options)
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByText('v0.1.0')
  return { ...fake, user }
}

const viewGroup = () => screen.getByRole('group', { name: 'View' })
const chatButton = () => within(viewGroup()).getByRole('button', { name: 'Chat' })
const commandButton = () => within(viewGroup()).getByRole('button', { name: 'Command' })
const commandBox = () => screen.getByRole('textbox', { name: 'Command' })
const hotkey = (init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    ctrlKey: true,
    altKey: true,
    code: 'Backslash',
    ...init,
  })

const shellPrompt = (overrides: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  id: 'ap-1',
  runId: 'run-1',
  toolUseId: 'cmd-1',
  tool: 'run_shell',
  kind: 'shell',
  summary: `Run a command in ${ROOT}`,
  detail: `cwd: ${ROOT}\nshell: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -EncodedCommand\n\ndir`,
  origin: 'user-terminal',
  ...overrides,
})

afterEach(() => {
  localStorage.clear()
})

describe('Chat | Command switch', () => {
  it('is a labelled pair of pressed-state buttons in the header, Chat first', async () => {
    await renderApp()
    expect(chatButton().getAttribute('aria-pressed')).toBe('true')
    expect(commandButton().getAttribute('aria-pressed')).toBe('false')
    expect(commandButton().getAttribute('aria-keyshortcuts')).toBe('Control+Alt+Backslash')
    // Settings is the sidebar gear, not a header button.
    const nav = screen.getByRole('navigation', { name: 'Header' })
    expect(within(nav).queryByRole('button', { name: /settings|preferences/i })).toBeNull()
  })

  it('swaps the composer for the command line, focused, and back; each keeps its own draft', async () => {
    const { user } = await renderApp()
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'a chat draft')
    await user.click(commandButton())
    expect(commandButton().getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
    await waitFor(() => {
      expect(document.activeElement).toBe(commandBox())
    })
    expect(screen.getByText(`PS ${ROOT}>`)).toBeTruthy()
    await user.type(commandBox(), 'Get-ChildItem')

    await user.click(chatButton())
    const message = screen.getByRole('textbox', { name: 'Message' })
    expect((message as HTMLTextAreaElement).value).toBe('a chat draft')
    await waitFor(() => {
      expect(document.activeElement).toBe(message)
    })
    await user.click(commandButton())
    expect((commandBox() as HTMLInputElement).value).toBe('Get-ChildItem')
  })

  it('toggles with Ctrl+Alt+\\ even from inside an input, but not on repeat or AltGraph', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('textbox', { name: 'Message' }))
    expect(hotkey()).toBe(false)
    expect(commandButton().getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => {
      expect(document.activeElement).toBe(commandBox())
    })
    hotkey({ repeat: true })
    hotkey({ modifierAltGraph: true })
    hotkey({ code: 'IntlBackslash', key: '\\' })
    expect(commandButton().getAttribute('aria-pressed')).toBe('true')
    hotkey()
    expect(chatButton().getAttribute('aria-pressed')).toBe('true')
  })

  it('ignores the hotkey while an approval is open', async () => {
    const { pushApproval } = await renderApp()
    act(() => {
      pushApproval(shellPrompt({ origin: 'agent', toolUseId: 't1' }))
    })
    await screen.findByRole('alertdialog')
    hotkey()
    expect(chatButton().getAttribute('aria-pressed')).toBe('true')
  })

  it('remembers the view per chat', async () => {
    const history = {
      activeId: A,
      conversations: [
        { id: A, title: 'Chat A', createdAt: 2, updatedAt: 2 },
        { id: B, title: 'Chat B', createdAt: 1, updatedAt: 1 },
      ],
    }
    const { user } = await renderApp({ history })
    await user.click(commandButton())
    await user.click(screen.getByRole('button', { name: 'Chat B' }))
    await waitFor(() => {
      expect(chatButton().getAttribute('aria-pressed')).toBe('true')
    })
    await user.click(screen.getByRole('button', { name: 'Chat A' }))
    await waitFor(() => {
      expect(commandButton().getAttribute('aria-pressed')).toBe('true')
    })
  })
})

describe('command bar', () => {
  it('runs the typed command in the granted folder, then clears it; Up/Down walk the history', async () => {
    const { api, user } = await renderApp()
    await user.click(commandButton())
    await user.type(commandBox(), 'dir{Enter}')
    expect(api.command.run).toHaveBeenCalledExactlyOnceWith('dir', ROOT)
    expect(api.chat.send).not.toHaveBeenCalled()
    await waitFor(() => {
      expect((commandBox() as HTMLInputElement).value).toBe('')
    })
    await user.type(commandBox(), 'git status{Enter}')
    await waitFor(() => {
      expect((commandBox() as HTMLInputElement).value).toBe('')
    })
    await user.type(commandBox(), 'half')
    await user.keyboard('{ArrowUp}')
    expect((commandBox() as HTMLInputElement).value).toBe('git status')
    await user.keyboard('{ArrowUp}')
    expect((commandBox() as HTMLInputElement).value).toBe('dir')
    await user.keyboard('{ArrowUp}')
    expect((commandBox() as HTMLInputElement).value).toBe('dir')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect((commandBox() as HTMLInputElement).value).toBe('half')
  })

  it('offers only the granted folders as the working folder', async () => {
    const { api, user } = await renderApp({
      grants: { roots: [ROOT, 'D:\\Docs'], loadError: null },
    })
    await user.click(commandButton())
    const folder = screen.getByRole('combobox', { name: 'Folder' })
    expect(
      within(folder)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([ROOT, 'D:\\Docs'])
    await user.selectOptions(folder, 'D:\\Docs')
    expect(screen.getByText('PS D:\\Docs>')).toBeTruthy()
    await user.type(commandBox(), 'dir{Enter}')
    expect(api.command.run).toHaveBeenCalledWith('dir', 'D:\\Docs')
  })

  it('without a granted folder, points to Settings instead of a command line', async () => {
    const { user } = await renderApp({ grants: { roots: [], loadError: null } })
    await user.click(commandButton())
    expect(screen.queryByRole('textbox', { name: 'Command' })).toBeNull()
    expect(screen.getByText('Grant a folder in Settings to run commands in it.')).toBeTruthy()
  })

  it('shows a refusal as a banner and keeps the command', async () => {
    const { api, user } = await renderApp()
    api.command.run.mockResolvedValueOnce({
      ok: false,
      code: 'busy',
      message: 'Wait for the current reply or command, or stop it.',
    })
    await user.click(commandButton())
    await user.type(commandBox(), 'dir{Enter}')
    expect(await screen.findByText(/Wait for the current reply or command/)).toBeTruthy()
    expect((commandBox() as HTMLInputElement).value).toBe('dir')
  })

  it("shows the whole folder in the prompt's tooltip, with hidden characters revealed", async () => {
    const { user, pushChat } = await renderApp()
    await user.click(commandButton())
    expect(document.querySelector('.command-prompt')?.getAttribute('title')).toBe(ROOT)
    act(() => {
      pushChat({
        type: 'command_started',
        runId: 'run-1',
        id: 'cmd-1',
        command: 'dir',
        cwd: `${ROOT}\\x\u202Etxt.exe`,
      })
    })
    const card = screen.getByRole('region', { name: 'Command you ran' })
    expect(card.querySelector('.command-card-prompt')?.getAttribute('title')).toBe(
      `${ROOT}\\x⟨U+202E⟩txt.exe`,
    )
  })

  it('shows the running command as a card, can be stopped with Esc, and shows its output', async () => {
    const { api, user, pushChat } = await renderApp()
    await user.click(commandButton())
    act(() => {
      pushChat({ type: 'command_started', runId: 'run-1', id: 'cmd-1', command: 'dir', cwd: ROOT })
    })
    const card = screen.getByRole('region', { name: 'Command you ran' })
    expect(within(card).getByText('running')).toBeTruthy()
    expect(within(card).getByRole('generic', { name: 'Command' }).textContent).toContain('dir')
    // Busy: no second command, and Stop in place of Run.
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()

    fireEvent.keyDown(commandBox(), { key: 'Escape' })
    expect(api.chat.stop).toHaveBeenCalledOnce()

    act(() => {
      pushChat({
        type: 'tool_result',
        runId: 'run-1',
        id: 'cmd-1',
        content: 'Cancelled; the process tree was killed.',
        isError: true,
        declined: false,
      })
      pushChat({ type: 'run_finished', runId: 'run-1', stopReason: 'error' })
    })
    expect(within(card).getByLabelText('Command error').textContent).toContain(
      'Cancelled; the process tree was killed.',
    )
    expect(within(card).getByText('failed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy()
  })

  it('shows a saved command as its own card, apart from the agent tool group', async () => {
    await renderApp({
      chat: {
        items: [
          { kind: 'tool', id: 't1', name: 'list_dir', input: { path: ROOT }, result: null },
          {
            kind: 'tool',
            id: 'cmd-1',
            name: 'run_shell',
            input: { command: 'dir', cwd: ROOT },
            result: { content: 'exit code: 0\nfile.txt', isError: false },
            origin: 'user-terminal',
          },
        ],
        running: false,
        loadError: null,
      },
    })
    const card = await screen.findByRole('region', { name: 'Command you ran' })
    expect(within(card).getByLabelText('Command output').textContent).toContain('file.txt')
    // The prompt can be cut short; its tooltip names the whole folder.
    expect(card.querySelector('.command-card-prompt')?.getAttribute('title')).toBe(ROOT)
    expect(screen.getByRole('region', { name: 'Tool activity' }).textContent).toContain(
      'Used 1 tool',
    )
  })
})

describe('approval prompt origin', () => {
  it('says when a command was typed in the command bar, and when the agent asked', () => {
    const respond = () => Promise.resolve()
    const view = render(<ApprovalCard prompt={shellPrompt()} queued={0} onRespond={respond} />)
    expect(screen.getByText(/Typed in the command bar/)).toBeTruthy()
    // The exact command is still shown, as for the agent.
    expect(screen.getByLabelText('Command').textContent).toContain('dir')
    view.rerender(
      <ApprovalCard
        key="agent"
        prompt={shellPrompt({ id: 'ap-2', origin: 'agent' })}
        queued={0}
        onRespond={respond}
      />,
    )
    expect(screen.getByText('Requested by the agent.')).toBeTruthy()
  })
})

describe('command cards and the conversation model', () => {
  const started = (id: string, command = 'dir') =>
    ({ type: 'command_started', runId: `run-${id}`, id, command, cwd: ROOT }) as const

  it('is queued while its approval is open, then denied if the user declines, with its time', async () => {
    const { pushChat, pushApproval } = await renderApp()
    act(() => {
      pushChat(started('cmd-1'))
      pushApproval(shellPrompt({ runId: 'run-cmd-1', toolUseId: 'cmd-1' }))
    })
    const card = screen.getByRole('region', { name: 'Command you ran' })
    expect(within(card).getByText('queued')).toBeTruthy()
    act(() => {
      pushChat({ type: 'approval_closed', approvalId: 'ap-1', approved: false })
      pushChat({
        type: 'tool_result',
        runId: 'run-cmd-1',
        id: 'cmd-1',
        content: 'The user declined to run the command. Nothing was run.',
        isError: true,
        declined: true,
      })
      pushChat({ type: 'run_finished', runId: 'run-cmd-1', stopReason: 'error' })
    })
    expect(within(card).getByText('denied')).toBeTruthy()
    expect(card.querySelector('.tool-elapsed')?.textContent).toMatch(/^\d+ms$|s$/)
  })

  it('shows failed, not denied, for a command whose own output reads like a decline', async () => {
    const { pushChat } = await renderApp()
    act(() => {
      pushChat(started('cmd-1'))
      pushChat({
        type: 'tool_result',
        runId: 'run-cmd-1',
        id: 'cmd-1',
        content: 'The user declined to run the command. Nothing was run.',
        isError: true,
        declined: false,
      })
      pushChat({ type: 'run_finished', runId: 'run-cmd-1', stopReason: 'error' })
    })
    const card = screen.getByRole('region', { name: 'Command you ran' })
    expect(within(card).getByText('failed')).toBeTruthy()
    expect(within(card).queryByText('denied')).toBeNull()
  })

  it('is not a prompt in the rail, and stays out of the folded work of earlier turns', async () => {
    setViewport(1280)
    const { pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'First question' })
      pushChat({ type: 'tool_use', runId: 'r1', turn: 1, id: 't1', name: 'list_dir', input: {} })
      pushChat({
        type: 'tool_result',
        runId: 'r1',
        id: 't1',
        content: 'a',
        isError: false,
        declined: false,
      })
      pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'end_turn' })
      pushChat(started('cmd-1', 'git status'))
      pushChat({
        type: 'tool_result',
        runId: 'run-cmd-1',
        id: 'cmd-1',
        content: 'clean',
        isError: false,
        declined: false,
      })
      pushChat({ type: 'run_finished', runId: 'run-cmd-1', stopReason: 'end_turn' })
      pushChat({ type: 'run_started', runId: 'r2', text: 'Second question' })
      pushChat({ type: 'run_finished', runId: 'r2', stopReason: 'end_turn' })
    })
    expect(
      screen
        .getAllByRole('button', { name: /^Jump to prompt/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Jump to prompt 1 of 2: First question', 'Jump to prompt 2 of 2: Second question'])
    // The first turn's agent work is folded; the command the user ran is not.
    const work = screen.getByRole('region', { name: 'Work' })
    expect(within(work).getByRole('button', { expanded: false })).toBeTruthy()
    const card = screen.getByRole('region', { name: 'Command you ran' })
    expect(work.contains(card)).toBe(false)
    expect(within(card).getByLabelText('Command output').textContent).toContain('clean')
  })
})
