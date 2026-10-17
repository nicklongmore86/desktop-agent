import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ApiContext } from '../../api'
import { App } from '../../App'
import { BUILTIN_CONNECTION_INFO } from '../../../../shared/connections-fixture'
import { fakeApi, type FakeApiOptions } from '../../test/fake-api'
import { setViewport } from '../../test/viewport'

async function renderApp(options: FakeApiOptions = {}) {
  setViewport(1280)
  const fake = fakeApi({ connections: BUILTIN_CONNECTION_INFO, ...options })
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByText('v0.1.0')
  return { ...fake, user }
}

const openAccounts = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole('button', { name: 'Settings' })[0] as HTMLElement)
  return screen.findByRole('list', { name: 'Connections' })
}
const card = (list: HTMLElement, title: string): HTMLElement => {
  const heading = within(list)
    .getAllByRole('heading', { level: 4 })
    .find((entry) => entry.textContent === title)
  const item = heading?.closest('li')
  if (!item) throw new Error(`No card for ${title}`)
  return item
}

describe('Accounts & providers cards', () => {
  it('lists the set-up connections with where each stands', async () => {
    const { user } = await renderApp({
      configured: ['anthropic-api', 'codex-subscription', 'claude-subscription'],
      statuses: {
        'claude-subscription': {
          provider: 'claude-subscription',
          state: 'signed-out',
          message: 'Sign in with your subscription.',
        },
      },
    })
    const list = await openAccounts(user)
    expect(
      within(list)
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual(['Claude · Subscription', 'Codex · ChatGPT', 'Anthropic API'])
    expect(within(card(list, 'Anthropic API')).getByText('In use')).toBeTruthy()
    expect(within(card(list, 'Codex · ChatGPT')).getByText('Ready')).toBeTruthy()
    expect(within(card(list, 'Claude · Subscription')).getByText('Not signed in')).toBeTruthy()
    // Connections that were never set up are not listed.
    expect(within(list).queryByText('OpenAI API')).toBeNull()
    // The one in use shows its key controls and model; the others offer to be used.
    expect(within(card(list, 'Anthropic API')).getByText('Key saved.')).toBeTruthy()
    expect(within(card(list, 'Anthropic API')).getByLabelText('Model')).toBeTruthy()
    expect(
      within(card(list, 'Codex · ChatGPT')).getByRole('button', { name: 'Use Codex · ChatGPT' }),
    ).toBeTruthy()
    expect(
      within(card(list, 'Claude · Subscription')).getByRole('button', {
        name: 'Set up Claude · Subscription',
      }),
    ).toBeTruthy()
  })

  it('shows the usage of the connection in use where it reports usage', async () => {
    const { user } = await renderApp({
      provider: { provider: 'codex-subscription', state: 'ready', message: 'Signed in' },
    })
    const list = await openAccounts(user)
    const codex = card(list, 'Codex · ChatGPT')
    expect(within(codex).getByRole('heading', { name: 'Usage' })).toBeTruthy()
    expect(within(codex).getByText('Connected')).toBeTruthy()
    expect(within(card(list, 'Anthropic API')).queryByRole('heading', { name: 'Usage' })).toBeNull()
  })

  it('opens Add connection from Settings, hides Settings behind it and returns to it', async () => {
    const { user } = await renderApp()
    await openAccounts(user)
    await user.click(screen.getByRole('button', { name: 'Add connection' }))
    const wizard = await screen.findByRole('dialog', { name: 'Which AI do you want to use?' })
    expect(
      screen.getByRole('dialog', { name: 'Settings', hidden: true }).closest('[hidden]'),
    ).toBeTruthy()
    await user.click(within(wizard).getByRole('button', { name: /^OpenRouter/ }))
    await user.keyboard('{Escape}')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /Which AI|use OpenRouter/ })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
  })

  it('sets up a connection that is not ready at its connect step', async () => {
    const { user, api } = await renderApp({
      statuses: {
        'codex-subscription': {
          provider: 'codex-subscription',
          state: 'signed-out',
          message: 'Sign in with your subscription.',
        },
      },
    })
    const list = await openAccounts(user)
    await user.click(within(card(list, 'Codex · ChatGPT')).getByRole('button', { name: /^Set up/ }))
    const wizard = await screen.findByRole('dialog', { name: 'Sign in to ChatGPT' })
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('codex-subscription')
    })
    expect(await within(wizard).findByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  describe('removing a connection', () => {
    const options: FakeApiOptions = {
      configured: ['anthropic-api', 'codex-subscription', 'openai-api'],
      keys: { 'openai-api': { saved: true, error: null } },
    }

    it('asks first, keeps chat history, and deletes the connection’s key', async () => {
      const { user, api } = await renderApp(options)
      const list = await openAccounts(user)
      await user.click(
        await within(await waitForCard(list, 'OpenAI API')).findByRole('button', {
          name: 'Remove OpenAI API',
        }),
      )
      const confirm = screen.getByRole('alertdialog')
      expect(within(confirm).getByText(/Your chat history for it stays on this PC/)).toBeTruthy()
      expect(within(confirm).getByText(/saved API key is deleted/)).toBeTruthy()
      // Cancel is focused first, and Esc cancels without removing anything.
      expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
      expect(api.connections.remove).not.toHaveBeenCalled()

      await user.click(
        within(card(list, 'OpenAI API')).getByRole('button', { name: 'Remove OpenAI API' }),
      )
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove connection' }),
      )
      await waitFor(() => {
        expect(api.connections.remove).toHaveBeenCalledExactlyOnceWith('openai-api')
      })
      expect(api.apiKey.clear).toHaveBeenCalledWith('openai-api')
      await waitFor(() => {
        expect(within(list).queryByText('OpenAI API')).toBeNull()
      })
      expect(api.chat.remove).not.toHaveBeenCalled()
    })

    it('does not let the connection in use be removed, and says why', async () => {
      const { user } = await renderApp(options)
      const list = await openAccounts(user)
      const inUse = await waitForCard(list, 'Anthropic API')
      const remove = within(inUse).getByRole('button', { name: 'Remove Anthropic API' })
      expect(remove).toHaveProperty('disabled', true)
      expect(
        within(inUse).getByText('Switch to another connection to remove this one.'),
      ).toBeTruthy()
    })

    it('reports a failed removal and keeps the connection', async () => {
      const { user, api } = await renderApp(options)
      api.connections.remove.mockRejectedValueOnce(new Error('disk full'))
      const list = await openAccounts(user)
      await user.click(
        within(await waitForCard(list, 'Codex · ChatGPT')).getByRole('button', {
          name: 'Remove Codex · ChatGPT',
        }),
      )
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove connection' }),
      )
      expect(await screen.findByText('Could not remove this connection. Try again.')).toBeTruthy()
      expect(within(list).getByText('Codex · ChatGPT')).toBeTruthy()
    })
  })

  describe('personal-use connections', () => {
    it('explains the setting, hides the Claude subscription when it is turned off, and shows it again', async () => {
      const { user, api } = await renderApp()
      const list = await openAccounts(user)
      expect(screen.getByText(/Anthropic’s terms require approval/)).toBeTruthy()
      const toggle = screen.getByRole('checkbox', { name: 'Show personal-use connections' })
      expect(toggle).toHaveProperty('checked', true)
      expect(within(list).getByText('Claude · Subscription')).toBeTruthy()
      await user.click(toggle)
      expect(api.connections.setShowPersonalUse).toHaveBeenCalledWith(false)
      await waitFor(() => {
        expect(within(list).queryByText('Claude · Subscription')).toBeNull()
      })
      expect(toggle).toHaveProperty('checked', false)
      // The composer's picker follows.
      expect(
        within(screen.getByRole('combobox', { name: 'Active provider', hidden: true }))
          .getAllByRole('option', { hidden: true })
          .map((option) => option.textContent),
      ).not.toContain('Claude · Subscription')
      await user.click(toggle)
      await waitFor(() => {
        expect(within(list).getByText('Claude · Subscription')).toBeTruthy()
      })
    })

    it('shows main’s refusal while chats go to a personal-use connection', async () => {
      const { user } = await renderApp({
        provider: { provider: 'claude-subscription', state: 'ready', message: 'Signed in' },
      })
      await openAccounts(user)
      await user.click(screen.getByRole('checkbox', { name: 'Show personal-use connections' }))
      expect(
        (await screen.findByText(/Switch to another connection before hiding/)).textContent,
      ).toBeTruthy()
      expect(
        screen.getByRole('checkbox', { name: 'Show personal-use connections' }),
      ).toHaveProperty('checked', true)
    })
  })
})

async function waitForCard(list: HTMLElement, title: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(within(list).getByText(title)).toBeTruthy()
  })
  return card(list, title)
}

describe('the composer’s connection picker', () => {
  it('lists what is ready, always the connection in use, and ends with Add or manage', async () => {
    await renderApp({
      configured: ['anthropic-api', 'codex-subscription', 'claude-subscription', 'openai-api'],
      statuses: {
        'claude-subscription': {
          provider: 'claude-subscription',
          state: 'signed-out',
          message: 'Sign in',
        },
      },
      // OpenAI API has no key, so it is configured but not ready.
    })
    const picker = screen.getByRole('combobox', { name: 'Active provider' })
    await waitFor(() => {
      expect(within(picker).getAllByRole('option')).toHaveLength(3)
    })
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Codex · ChatGPT', 'Claude · API', 'Add or manage connections…'])
  })

  it('opens the Add connection flow from its last item and leaves the choice alone', async () => {
    const { user, api } = await renderApp()
    const picker = screen.getByRole('combobox', { name: 'Active provider' })
    await user.selectOptions(picker, 'Add or manage connections…')
    expect(await screen.findByRole('dialog', { name: 'Which AI do you want to use?' })).toBeTruthy()
    expect(api.provider.set).not.toHaveBeenCalled()
    expect(picker).toHaveProperty('value', 'anthropic-api')
  })
})
