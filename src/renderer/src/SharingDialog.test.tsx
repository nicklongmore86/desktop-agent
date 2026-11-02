import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SendResult, SharingPrompt } from '../../shared/ipc'
import { ApiContext } from './api'
import { App } from './App'
import { fakeApi } from './test/fake-api'

const PROMPT: SharingPrompt = {
  id: 'share-1',
  chat: { provider: 'ollama', id: 'c1' },
  connection: 'openai-api',
  destination: 'OpenAI · API',
  reasons: ['local-to-cloud'],
  sources: ['Ollama · Local'],
  includes: { messages: 6, toolOutput: true, attachments: 2 },
}
const REFUSED: SendResult = {
  ok: false,
  code: 'confirmation_required',
  message: 'Confirm before this chat is sent to OpenAI · API.',
  sharing: PROMPT,
}

async function renderApp() {
  const fake = fakeApi()
  // Main refuses until the confirmation is recorded, like ChatSession.send.
  let confirmed = false
  fake.api.chat.send.mockImplementation(() => Promise.resolve(confirmed ? { ok: true } : REFUSED))
  fake.api.chat.confirmSharing.mockImplementation((id: string) => {
    confirmed = id === PROMPT.id
    return Promise.resolve(confirmed ? { ok: true } : { ok: false, message: 'No.' })
  })
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByText('v0.1.0')
  const box = screen.getByRole('textbox', { name: 'Message' })
  await user.type(box, 'Keep going')
  await user.keyboard('{Enter}')
  const dialog = await screen.findByRole('alertdialog', { name: /Send this chat to OpenAI/ })
  return { ...fake, user, box, dialog }
}

describe('SharingDialog: main refused a send to another vendor', () => {
  it('names what will be sent and where, with Cancel focused', async () => {
    const { dialog } = await renderApp()
    expect(dialog.textContent).toContain('Ollama · Local')
    expect(dialog.textContent).toContain('OpenAI · API')
    expect(dialog.textContent).toContain('6 earlier messages')
    expect(dialog.textContent).toContain('File contents and command output')
    expect(dialog.textContent).toContain('2 attached files')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    // No error banner while it asks.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Confirm records it in main, then sends the same message again', async () => {
    const { api, user, box } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => {
      expect(api.chat.send).toHaveBeenCalledTimes(2)
    })
    expect(api.chat.confirmSharing).toHaveBeenCalledWith('share-1')
    expect(api.chat.send).toHaveBeenLastCalledWith('Keep going')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect((box as HTMLTextAreaElement).value).toBe('')
    })
  })

  it('Cancel and Escape confirm nothing and keep the draft', async () => {
    const { api, user, box } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.chat.confirmSharing).not.toHaveBeenCalled()
    expect(api.chat.send).toHaveBeenCalledOnce()
    expect((box as HTMLTextAreaElement).value).toBe('Keep going')

    await user.click(box)
    await user.keyboard('{Enter}')
    await screen.findByRole('alertdialog')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.chat.confirmSharing).not.toHaveBeenCalled()
    expect((box as HTMLTextAreaElement).value).toBe('Keep going')
  })

  it('shows the Gemini free-tier notice', async () => {
    const fake = fakeApi()
    fake.api.chat.send.mockResolvedValue({
      ...REFUSED,
      sharing: {
        ...PROMPT,
        destination: 'Gemini · API',
        connection: 'gemini-api',
        reasons: ['gemini-free-tier'],
        sources: ['Claude · API'],
        notice: { title: 'Free Gemini API keys share your data with Google', text: 'Do not.' },
      },
    })
    const user = userEvent.setup()
    render(
      <ApiContext value={fake.api}>
        <App />
      </ApiContext>,
    )
    await screen.findByText('v0.1.0')
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hi{Enter}')
    const dialog = await screen.findByRole('alertdialog', { name: /Gemini/ })
    expect(dialog.textContent).toContain('Free Gemini API keys share your data with Google')
  })

  it('an approval takes priority: the dialog is hidden and inert under it', async () => {
    const { pushApproval, dialog } = await renderApp()
    act(() => {
      pushApproval({
        id: 'a1',
        runId: 'r0',
        toolUseId: null,
        tool: 'write_file',
        kind: 'write',
        summary: 'Write a.txt',
        detail: null,
      })
    })
    const backdrop = dialog.parentElement as HTMLElement
    expect(backdrop.hidden).toBe(true)
    expect(backdrop.hasAttribute('inert')).toBe(true)
  })
})
