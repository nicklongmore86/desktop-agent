import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent, SendResult } from '../../shared/ipc'
import { ApiContext } from './api'
import { App } from './App'
import { ErrorBanner } from './components/ErrorBanner'
import { fakeApi, type FakeApiOptions } from './test/fake-api'

const PAUSED = 'Paused after 35 steps. Your progress is saved.'

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

/** A run that reached its turn limit: main's error comes before run_finished. */
function pausedRun(pushChat: (event: ChatEvent) => void, finish = true): void {
  act(() => {
    pushChat({ type: 'run_started', runId: 'r1', text: 'Tidy my folder' })
    pushChat({ type: 'error', runId: 'r1', code: 'max_turns', message: PAUSED })
  })
  if (finish)
    act(() => {
      pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'max_turns' })
    })
}

const notice = () => screen.getByText(PAUSED).closest('.banner') as HTMLElement
const continueButton = () => screen.getByRole('button', { name: 'Continue' })

describe('ErrorBanner for a paused run', () => {
  const banner = { code: 'max_turns', message: PAUSED } as const

  it('is a neutral status, not an alert, with no error title', () => {
    render(
      <ErrorBanner
        banner={banner}
        onDismiss={vi.fn()}
        onOpenSettings={vi.fn()}
        onNewChat={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    const status = screen.getByRole('status')
    expect(status.className).toContain('banner-info')
    expect(status.textContent).toContain(PAUSED)
    expect(status.textContent).not.toContain('Turn limit')
    expect(status.textContent).not.toContain('Review the conversation')
  })

  it('offers Continue only with a handler, and disables it on request', async () => {
    const onContinue = vi.fn()
    const props = {
      banner,
      onDismiss: vi.fn(),
      onOpenSettings: vi.fn(),
      onNewChat: vi.fn(),
    }
    const { rerender } = render(<ErrorBanner {...props} />)
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    rerender(<ErrorBanner {...props} onContinue={onContinue} continueDisabled />)
    expect(continueButton()).toHaveProperty('disabled', true)
    rerender(<ErrorBanner {...props} onContinue={onContinue} />)
    await userEvent.setup().click(continueButton())
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('never offers Continue for other errors', () => {
    render(
      <ErrorBanner
        banner={{ code: 'max_tokens', message: 'Too long.' }}
        onDismiss={vi.fn()}
        onOpenSettings={vi.fn()}
        onNewChat={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Reply too long')
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})

describe('Continue after a paused run', () => {
  it('stays disabled until the run has finished, then sends "Continue" once', async () => {
    const { api, user, pushChat } = await renderApp()
    pausedRun(pushChat, false)
    expect(notice().getAttribute('role')).toBe('status')
    expect(continueButton()).toHaveProperty('disabled', true)
    await user.click(continueButton())
    expect(api.chat.send).not.toHaveBeenCalled()

    act(() => {
      pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'max_turns' })
    })
    expect(continueButton()).toHaveProperty('disabled', false)
    // Like main: the run starts (clearing the notice) before the send answers.
    api.chat.send.mockImplementation((text: string): Promise<SendResult> => {
      pushChat({ type: 'run_started', runId: 'r2', text })
      return Promise.resolve({ ok: true })
    })
    await user.dblClick(continueButton())
    expect(api.chat.send).toHaveBeenCalledExactlyOnceWith('Continue')
    expect(screen.queryByText(PAUSED)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('goes through the normal send, so a refusal is shown like any other', async () => {
    const { api, user, pushChat } = await renderApp()
    pausedRun(pushChat)
    api.chat.send.mockResolvedValueOnce({
      ok: false,
      code: 'busy',
      message: 'Chat is busy. Try again in a moment.',
    })
    await user.click(continueButton())
    expect(api.chat.send).toHaveBeenCalledExactlyOnceWith('Continue')
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Chat is busy. Try again in a moment.',
    )
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('leaves the message draft alone', async () => {
    const { api, user, pushChat } = await renderApp()
    pausedRun(pushChat)
    const box = screen.getByRole('textbox', { name: 'Message' })
    await user.type(box, 'half-written')
    await user.click(continueButton())
    expect(api.chat.send).toHaveBeenCalledExactlyOnceWith('Continue')
    expect(box).toHaveProperty('value', 'half-written')
  })

  it('is gone after New chat, and does not come back', async () => {
    const { api, user, pushChat } = await renderApp()
    pausedRun(pushChat)
    expect(screen.getByText(PAUSED)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => {
      expect(api.chat.newChat).toHaveBeenCalledOnce()
    })
    expect(screen.queryByText(PAUSED)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    // A straggler from the paused run is ignored.
    act(() => {
      pushChat({ type: 'error', runId: 'r1', code: 'max_turns', message: PAUSED })
    })
    expect(screen.queryByText(PAUSED)).toBeNull()
  })

  it('is gone after a provider switch', async () => {
    const { user, pushChat } = await renderApp()
    pausedRun(pushChat)
    await screen.findByRole('option', { name: 'Codex · ChatGPT' })
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active provider' }),
      'codex-subscription',
    )
    await waitFor(() => {
      expect(screen.queryByText(PAUSED)).toBeNull()
    })
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})
