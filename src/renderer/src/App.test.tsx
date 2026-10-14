import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiContext } from './api'
import { App } from './App'
import { fakeApi, type FakeApiOptions } from './test/fake-api'

async function renderApp(options: FakeApiOptions = {}) {
  const fake = fakeApi(options)
  const user = userEvent.setup()
  const view = render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  // Let the initial status loads settle.
  await screen.findByText('v0.1.0')
  return { ...fake, user, view }
}

describe('chat view', () => {
  it('sends a message and renders the streamed reply and tool cards', async () => {
    const { api, user, pushChat } = await renderApp()
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'List my files{Enter}')
    expect(api.chat.send).toHaveBeenCalledWith('List my files')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', '')

    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'List my files' })
      pushChat({ type: 'text_delta', runId: 'r1', turn: 1, text: 'Checking **your** ' })
      pushChat({ type: 'text_delta', runId: 'r1', turn: 1, text: 'folder.' })
      pushChat({
        type: 'tool_use',
        runId: 'r1',
        turn: 1,
        id: 't1',
        name: 'list_dir',
        input: { path: 'C:\\Users\\me\\Projects' },
      })
    })
    const messages = screen.getByRole('list', { name: 'Messages' })
    expect(within(messages).getByText('List my files')).toBeTruthy()
    expect(within(messages).getByText('your').tagName).toBe('STRONG')
    expect(messages.textContent).toContain('Checking your folder.')
    expect(within(messages).getByText('list_dir')).toBeTruthy()
    expect(within(messages).getByText('C:\\Users\\me\\Projects')).toBeTruthy()
    expect(within(messages).getByText('running')).toBeTruthy()

    act(() => {
      pushChat({ type: 'tool_result', runId: 'r1', id: 't1', content: 'Boom', isError: true })
    })
    expect(within(messages).getByText('error')).toBeTruthy()
    // The card is collapsible: the result is inside a <details>.
    const card = within(messages).getByText('list_dir').closest('details')
    expect(card).toBeTruthy()
    await user.click(within(messages).getByText('list_dir'))
    expect(card?.open).toBe(true)
    expect(within(card as HTMLElement).getByText('Boom')).toBeTruthy()
  })

  it('shows Stop while running and calls stop', async () => {
    const { api, user, pushChat } = await renderApp()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
      pushChat({ type: 'text_delta', runId: 'r1', turn: 1, text: 'Partial answer' })
    })
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(api.chat.stop).toHaveBeenCalledOnce()
    act(() => {
      pushChat({ type: 'error', runId: 'r1', code: 'aborted', message: 'Agent run cancelled.' })
      pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'aborted' })
    })
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.getByText('Stopped. This reply was not saved.')).toBeTruthy()
  })

  it('removes streamed text when the response is discarded', async () => {
    const { pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
      pushChat({ type: 'text_delta', runId: 'r1', turn: 1, text: 'About to call a tool' })
    })
    expect(screen.getByText('About to call a tool')).toBeTruthy()
    act(() => {
      pushChat({ type: 'response_discarded', runId: 'r1', turn: 1 })
    })
    expect(screen.queryByText('About to call a tool')).toBeNull()
  })

  it.each([
    ['authentication', 'API key rejected', true],
    ['permission', 'Access denied by the API', true],
    ['rate_limit', 'Rate limit reached', false],
    ['overloaded', 'Claude is overloaded', false],
    ['network', 'Connection problem', false],
    ['invalid_request', 'Request rejected', false],
    ['max_tokens', 'Reply too long', false],
  ] as const)('shows a clear banner for %s errors', async (code, title, settings) => {
    const { user, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
      pushChat({ type: 'error', runId: 'r1', code, message: 'Details from main.' })
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(title)
    expect(alert.textContent).toContain('Details from main.')
    const open = within(alert).queryByRole('button', { name: 'Open Settings' })
    expect(open !== null).toBe(settings)
    if (open) {
      await user.click(open)
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()
    } else {
      await user.click(within(alert).getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByRole('alert')).toBeNull()
    }
  })

  it('shows a send failure (no key) as a banner and keeps the draft', async () => {
    const { api, user } = await renderApp()
    api.chat.send.mockResolvedValueOnce({
      ok: false,
      code: 'no_api_key',
      message: 'Add your Anthropic API key in Settings.',
    } as never)
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hello{Enter}')
    expect(screen.getByRole('alert').textContent).toContain('No API key')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Hello')
  })

  it('renders model Markdown without raw HTML, images or unsafe links', async () => {
    const { pushChat, view } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
      pushChat({
        type: 'text_delta',
        runId: 'r1',
        turn: 1,
        text: [
          '<img src="x" onerror="alert(1)"><script>alert(2)</script><b>bold?</b>',
          '',
          '![tracker](https://evil.example/pixel.png)',
          '',
          '[docs](https://example.com/docs) and [bad](javascript:alert(3))',
        ].join('\n'),
      })
    })
    const { container } = view
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.innerHTML).not.toContain('onerror')
    expect(screen.getByText('[image: tracker]')).toBeTruthy()
    const docs = screen.getByRole('link', { name: 'docs' })
    expect(docs.getAttribute('href')).toBe('https://example.com/docs')
    expect(docs.getAttribute('target')).toBe('_blank')
    expect(docs.getAttribute('rel')).toContain('noopener')
    const bad = screen.getByText('bad').closest('a')
    expect(bad?.getAttribute('href') ?? '').not.toMatch(/javascript/i)
  })

  it('starts a new chat', async () => {
    const { api, user } = await renderApp({
      chat: {
        items: [{ kind: 'user', id: 'h0.0', text: 'Saved message' }],
        running: false,
        loadError: null,
      },
    })
    expect(screen.getByText('Saved message')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect(api.chat.newChat).toHaveBeenCalledOnce()
    expect(screen.queryByText('Saved message')).toBeNull()
  })

  it('warns when audit logging fails', async () => {
    const { pushAudit } = await renderApp()
    expect(screen.queryByText(/Audit logging is failing/)).toBeNull()
    act(() => {
      pushAudit({ healthy: false, path: 'C:\\Data\\audit.jsonl' })
    })
    expect(screen.getByRole('alert').textContent).toContain('Audit logging is failing')
  })

  it('shows storage warnings, keeps them across New chat and lets the user dismiss them', async () => {
    const { user, pushChat } = await renderApp()
    act(() => {
      pushChat({
        type: 'storage_warning',
        message: 'The previous conversation could not be deleted from disk.',
      })
      pushChat({ type: 'conversation_reset' })
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Storage problem.')
    expect(alert.textContent).toContain('could not be deleted from disk')
    await user.click(screen.getByRole('button', { name: 'Dismiss storage warning' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('recovers from a crash in the chat view through the error boundary', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { api, user, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
      // A tool card whose input cannot be summarised or stringified crashes nothing...
      pushChat({
        type: 'tool_use',
        runId: 'r1',
        turn: 1,
        id: 't1',
        name: 'x',
        input: { path: 'C:\\a' },
      })
    })
    expect(screen.queryByText('The chat view hit an error.')).toBeNull()
    // ...but a malformed item from main (text that is not a string) does.
    act(() => {
      pushChat({ type: 'text_delta', runId: 'r1', turn: 2, text: { bad: true } as never })
    })
    expect(screen.getByRole('alert').textContent).toContain('The chat view hit an error.')
    // The rest of the app still works.
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Start a new chat' }))
    expect(api.chat.newChat).toHaveBeenCalledOnce()
    expect(screen.queryByText('The chat view hit an error.')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy()
    error.mockRestore()
  })

  it('unsubscribes from main pushes on unmount', async () => {
    const { view, listenerCount } = await renderApp()
    expect(listenerCount()).toBe(3)
    view.unmount()
    expect(listenerCount()).toBe(0)
  })
})

describe('first run', () => {
  it('guides the user to Settings when there is no key or grant', async () => {
    const { user } = await renderApp({
      key: { saved: false, error: null },
      grants: { roots: [], loadError: null },
    })
    const guide = screen.getByRole('note', { name: 'Finish setting up' })
    expect(guide.textContent).toContain('Add your Anthropic API key')
    expect(guide.textContent).toContain('Grant at least one folder')
    await user.click(within(guide).getByRole('button', { name: 'Open Settings' }))
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()
  })

  it('stays out of the way once set up', async () => {
    await renderApp()
    expect(screen.queryByRole('note', { name: 'Finish setting up' })).toBeNull()
  })
})

it('offers both subscriptions without an API-key setup gate and keeps API mode available', async () => {
  const { api, user } = await renderApp({ key: { saved: false, error: null } })
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  for (const provider of ['claude-subscription', 'codex-subscription']) {
    await user.selectOptions(screen.getByLabelText('Access provider'), provider)
    expect(api.provider.set).toHaveBeenLastCalledWith(provider)
    expect(screen.queryByRole('heading', { name: 'Anthropic API key' })).toBeNull()
    expect(screen.getByText(/No API key required/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Sign in with subscription' }))
    await user.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(screen.queryByText(/Add your Anthropic API key/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
  }
  await user.selectOptions(screen.getByLabelText('Access provider'), 'anthropic-api')
  expect(screen.getByRole('heading', { name: 'Anthropic API key' })).toBeTruthy()
})

it('does not let an old startup history response overwrite a provider switch', async () => {
  const fake = fakeApi()
  let release: (state: import('../../shared/ipc').ChatState) => void = () => {}
  fake.api.chat.load.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByText('v0.1.0')
  act(() => {
    fake.pushChat({
      type: 'conversation_reset',
      state: {
        items: [{ kind: 'user', id: 'new', text: 'New provider history' }],
        running: false,
        loadError: null,
      },
    })
  })
  await act(async () => {
    release({
      items: [{ kind: 'user', id: 'old', text: 'Old provider history' }],
      running: false,
      loadError: null,
    })
    await Promise.resolve()
  })
  expect(screen.getByText('New provider history')).toBeTruthy()
  expect(screen.queryByText('Old provider history')).toBeNull()
})
