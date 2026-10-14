import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalPrompt } from '../../../shared/ipc'
import { ApiContext } from '../api'
import { App } from '../App'
import { fakeApi } from '../test/fake-api'
import { ApprovalCard, parseShellDetail } from './ApprovalCard'

const writePrompt: ApprovalPrompt = {
  id: 'approval-1',
  runId: 'r1',
  toolUseId: 't1',
  tool: 'write_file',
  kind: 'write',
  summary: 'Replace C:\\work\\notes.txt with 12 B of text',
  detail: '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n same\n-old line\n+new line\n',
}

const shellCommand = 'Get-ChildItem -Recurse | Remove-Item  "C:\\work\\tmp"\n# second line'
const shellPrompt: ApprovalPrompt = {
  id: 'approval-2',
  runId: 'r1',
  toolUseId: 't2',
  tool: 'run_shell',
  kind: 'shell',
  summary: 'Run a command in C:\\work',
  detail: `cwd: C:\\work\nshell: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command\n\n${shellCommand}`,
}

function renderCard(prompt: ApprovalPrompt, queued = 0) {
  const onRespond = vi.fn((_id: string, _approved: boolean) => Promise.resolve())
  const user = userEvent.setup()
  render(<ApprovalCard prompt={prompt} queued={queued} onRespond={onRespond} />)
  return { onRespond, user, dialog: screen.getByRole('alertdialog') }
}

describe('ApprovalCard', () => {
  it('focuses Deny by default and approves only on an explicit click', async () => {
    const { onRespond, user, dialog } = renderCard(writePrompt)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByRole('heading').textContent).toBe('Approve: Write a file?')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Deny' }))
    expect(onRespond).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onRespond).toHaveBeenCalledExactlyOnceWith('approval-1', true)
    // Answered: both buttons disable so a double click cannot answer twice.
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true)
  })

  it('denies with Enter on the default button and with Escape', async () => {
    const first = renderCard(writePrompt)
    await first.user.keyboard('{Enter}')
    expect(first.onRespond).toHaveBeenCalledExactlyOnceWith('approval-1', false)
  })

  it('denies with Escape', async () => {
    const { onRespond, user } = renderCard(writePrompt)
    await user.keyboard('{Escape}')
    expect(onRespond).toHaveBeenCalledExactlyOnceWith('approval-1', false)
  })

  it('keeps Tab focus inside the dialog', async () => {
    const { user, dialog } = renderCard(writePrompt)
    for (let i = 0; i < 6; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await user.tab({ shift: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('renders the full diff monospace with +/- colouring, scrollable', () => {
    renderCard(writePrompt)
    const diff = screen.getByLabelText('Full diff')
    expect(diff.tagName).toBe('PRE')
    expect(diff.className).toContain('scroll-box')
    expect(diff.getAttribute('tabindex')).toBe('0')
    expect(screen.getByText('+new line').className).toContain('diff-add')
    expect(screen.getByText('-old line').className).toContain('diff-del')
    expect(screen.getByText('@@ -1,2 +1,2 @@').className).toContain('diff-hunk')
    expect(screen.getByText('+++ b/notes.txt').className).toContain('diff-file')
    expect(diff.textContent).toBe(writePrompt.detail)
  })

  it('shows the exact shell path, cwd and command verbatim', () => {
    renderCard(shellPrompt)
    expect(screen.getByText('Approve: Run a shell command?')).toBeTruthy()
    expect(
      screen.getByText(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command',
      ),
    ).toBeTruthy()
    expect(screen.getByLabelText('Working folder').textContent).toBe('C:\\work')
    expect(screen.getByLabelText('Command').textContent).toBe(shellCommand)
  })

  it('falls back to the raw detail for other kinds', () => {
    renderCard({
      ...writePrompt,
      id: 'approval-3',
      tool: 'move_file',
      kind: 'move',
      summary: 'Move a to b',
      detail: 'C:\\a\n→ C:\\b',
    })
    expect(screen.getByLabelText('Details').textContent).toBe('C:\\a\n→ C:\\b')
  })

  it('says how many more prompts are queued', () => {
    renderCard(writePrompt, 2)
    expect(screen.getByText('2 more requests waiting.')).toBeTruthy()
  })

  it('parses only the exact run_shell detail format', () => {
    expect(parseShellDetail('cwd: /w\nshell: /bin/sh -c\n\nls -la\npwd')).toEqual({
      cwd: '/w',
      shell: '/bin/sh -c',
      command: 'ls -la\npwd',
    })
    expect(parseShellDetail('rm -rf /')).toBeNull()
  })
})

describe('approval flow in the app', () => {
  it('shows pushed prompts one at a time and answers them by id', async () => {
    const fake = fakeApi()
    const user = userEvent.setup()
    render(
      <ApiContext value={fake.api}>
        <App />
      </ApiContext>,
    )
    await screen.findByText('v0.1.0')
    act(() => {
      fake.pushChat({ type: 'run_started', runId: 'r1', text: 'Do it' })
      fake.pushApproval(writePrompt)
      fake.pushApproval(shellPrompt)
    })
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
    expect(screen.getByText('1 more request waiting.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(fake.api.approvals.respond).toHaveBeenCalledExactlyOnceWith('approval-1', false)
    act(() => {
      fake.pushChat({ type: 'approval_closed', approvalId: 'approval-1', approved: false })
    })
    expect(screen.getByText('Approve: Run a shell command?')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Deny' }))
    act(() => {
      fake.pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'aborted' })
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
