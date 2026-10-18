import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderStatus } from '../../shared/ipc'
import { MANAGE_USAGE_URL } from '../../shared/chatgpt-plan'
import { ApiContext } from './api'
import { App } from './App'
import { fakeApi, type FakeApiOptions } from './test/fake-api'

const PLAN: ProviderStatus = {
  provider: 'chatgpt-plan',
  state: 'ready',
  signedIn: true,
  message: 'Signed in with ChatGPT.',
}
const CODEX: ProviderStatus = {
  provider: 'codex-subscription',
  state: 'ready',
  signedIn: true,
  message: 'Signed in.',
}
const PLAN_CONFIGURED = ['anthropic-api', 'codex-subscription', 'chatgpt-plan']

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

beforeEach(() => {
  localStorage.clear()
})

describe('the composer label', () => {
  it('names the plan and links to the fixed usage page while ChatGPT · Plan is in use', async () => {
    await renderApp({ provider: PLAN, configured: PLAN_CONFIGURED })
    const label = (await screen.findByText('Using ChatGPT plan')).parentElement as HTMLElement
    const link = within(label).getByRole('link', { name: 'Manage usage' })
    expect(link.getAttribute('href')).toBe(MANAGE_USAGE_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')
  })

  it('is absent on every other connection and while signed out', async () => {
    await renderApp({ provider: CODEX })
    expect(screen.queryByText('Using ChatGPT plan')).toBeNull()
  })

  it('is absent while ChatGPT · Plan is signed out', async () => {
    await renderApp({
      provider: { ...PLAN, state: 'signed-out', signedIn: false },
      configured: PLAN_CONFIGURED,
    })
    expect(screen.queryByText('Using ChatGPT plan')).toBeNull()
  })
})

describe('limit and plan errors', () => {
  it.each([
    ['usage_limit', 'Plan limit reached'],
    ['plan_not_entitled', 'Plan upgrade required'],
  ] as const)('offer Manage usage for %s on ChatGPT · Plan', async (code, title) => {
    const { pushChat } = await renderApp({ provider: PLAN, configured: PLAN_CONFIGURED })
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
      pushChat({ type: 'error', runId: 'r1', code, message: 'Safe explanation.' })
      pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'error' })
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(title)
    expect(within(alert).getByRole('link', { name: 'Manage usage' }).getAttribute('href')).toBe(
      MANAGE_USAGE_URL,
    )
    // Settings stays available beside it.
    expect(within(alert).getByRole('button', { name: 'Open Settings' })).toBeTruthy()
  })

  it('do not offer it on another connection', async () => {
    const { pushChat } = await renderApp({ provider: CODEX })
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
      pushChat({ type: 'error', runId: 'r1', code: 'usage_limit', message: 'Safe explanation.' })
      pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'error' })
    })
    expect(within(screen.getByRole('alert')).queryByRole('link')).toBeNull()
  })
})

describe('the first-use plan notice', () => {
  it('shows once, then stays away across restarts', async () => {
    const first = await renderApp({ provider: PLAN, configured: PLAN_CONFIGURED })
    const dialog = await screen.findByRole('dialog', { name: 'You’re using your ChatGPT plan' })
    expect(within(dialog).getByRole('link', { name: 'Manage usage' }).getAttribute('href')).toBe(
      MANAGE_USAGE_URL,
    )
    const gotIt = within(dialog).getByRole('button', { name: 'Got it' })
    expect(document.activeElement).toBe(gotIt)
    await first.user.click(gotIt)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localStorage.getItem('plan-notice-seen:chatgpt-plan')).toBe('1')

    // A new launch with the flag saved does not show it again.
    document.body.replaceChildren()
    await renderApp({ provider: PLAN, configured: PLAN_CONFIGURED })
    expect(screen.queryByRole('dialog', { name: 'You’re using your ChatGPT plan' })).toBeNull()
  })

  it('is dismissed by Escape and is not shown for other connections', async () => {
    const { user } = await renderApp({ provider: PLAN, configured: PLAN_CONFIGURED })
    await screen.findByRole('dialog', { name: 'You’re using your ChatGPT plan' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('never shows for a connection that is not ChatGPT · Plan', async () => {
    await renderApp({ provider: CODEX })
    expect(screen.queryByRole('dialog', { name: 'You’re using your ChatGPT plan' })).toBeNull()
  })

  it('still works when storage is unavailable, for this run', async () => {
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      const { user } = await renderApp({ provider: PLAN, configured: PLAN_CONFIGURED })
      await user.click(await screen.findByRole('button', { name: 'Got it' }))
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      blocked.mockRestore()
    }
  })

  it('gives way to an approval, which keeps its dialog and focus', async () => {
    const { pushApproval } = await renderApp({ provider: PLAN, configured: PLAN_CONFIGURED })
    const notice = await screen.findByRole('dialog', { name: 'You’re using your ChatGPT plan' })
    act(() => {
      pushApproval({
        id: 'a1',
        runId: 'r1',
        toolUseId: null,
        tool: 'write_file',
        kind: 'write',
        summary: 'Write a file',
        detail: null,
      })
    })
    const approval = await screen.findByRole('alertdialog')
    expect((notice.closest('.modal-backdrop') as HTMLElement).hidden).toBe(true)
    expect(approval.closest('[hidden], [inert]')).toBeNull()
  })
})

describe('the plan notice and an approval together', () => {
  const prompt = {
    id: 'a1',
    runId: 'r1',
    toolUseId: null,
    tool: 'write_file',
    kind: 'write' as const,
    summary: 'Write a file',
    detail: null,
  }

  it('lets Esc deny the approval, then shows the notice again for Esc to dismiss', async () => {
    const { api, user, pushApproval, pushChat } = await renderApp({
      provider: PLAN,
      configured: PLAN_CONFIGURED,
    })
    const title = 'You’re using your ChatGPT plan'
    await screen.findByRole('dialog', { name: title })
    act(() => {
      pushApproval(prompt)
    })
    const approval = await screen.findByRole('alertdialog')
    // Focus is in the approval (Deny), and the notice is hidden beneath it.
    await waitFor(() => {
      expect(approval.contains(document.activeElement)).toBe(true)
    })
    expect(screen.queryByRole('dialog', { name: title })).toBeNull()

    await user.keyboard('{Escape}')
    expect(api.approvals.respond).toHaveBeenCalledExactlyOnceWith('a1', false)
    // Esc went to the approval: the notice was not marked seen.
    expect(localStorage.getItem('plan-notice-seen:chatgpt-plan')).toBeNull()

    act(() => {
      pushChat({ type: 'approval_closed', approvalId: 'a1', approved: false })
    })
    const notice = await screen.findByRole('dialog', { name: title })
    await waitFor(() => {
      expect(notice.contains(document.activeElement)).toBe(true)
    })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: title })).toBeNull()
    expect(localStorage.getItem('plan-notice-seen:chatgpt-plan')).toBe('1')
  })

  it('leaves the global shortcuts as they were: off under an approval, off under the notice', async () => {
    const { api, user, pushApproval, pushChat } = await renderApp({
      provider: PLAN,
      configured: PLAN_CONFIGURED,
    })
    await screen.findByRole('dialog', { name: 'You’re using your ChatGPT plan' })
    // Notice showing: Ctrl+N does nothing.
    await user.keyboard('{Control>}n{/Control}')
    expect(api.chat.newChat).not.toHaveBeenCalled()
    act(() => {
      pushApproval(prompt)
    })
    await screen.findByRole('alertdialog')
    await user.keyboard('{Control>}n{/Control}')
    expect(api.chat.newChat).not.toHaveBeenCalled()
    act(() => {
      pushChat({ type: 'approval_closed', approvalId: 'a1', approved: false })
    })
    await user.click(await screen.findByRole('button', { name: 'Got it' }))
    // Both gone: the shortcut works again.
    await user.keyboard('{Control>}n{/Control}')
    expect(api.chat.newChat).toHaveBeenCalledOnce()
  })
})

describe('the invitation for Codex · ChatGPT users', () => {
  it('shows on Codex, opens the wizard at ChatGPT · Plan, and dismisses for good', async () => {
    const { user, api } = await renderApp({ provider: CODEX })
    const banner = await screen.findByRole('region', { name: 'New' })
    expect(banner.textContent).toContain('Use your ChatGPT plan in this app.')
    await user.click(within(banner).getByRole('button', { name: 'Set up ChatGPT · Plan' }))
    const wizard = await screen.findByRole('dialog', { name: 'Sign in with ChatGPT' })
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('chatgpt-plan')
    })
    expect(within(wizard).getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy()
  })

  it('goes away when dismissed and stays away', async () => {
    const { user } = await renderApp({ provider: CODEX })
    const banner = await screen.findByRole('region', { name: 'New' })
    await user.click(within(banner).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('region', { name: 'New' })).toBeNull()
    expect(localStorage.getItem('plan-switch-banner-dismissed')).toBe('1')
  })

  it('is not shown on other connections', async () => {
    await renderApp()
    expect(screen.queryByRole('region', { name: 'New' })).toBeNull()
  })
})
