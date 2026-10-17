import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ApprovalPrompt,
  ChatEvent,
  ProviderAllowance,
  ProviderModels,
  ProviderResult,
} from '../../shared/ipc'
import { ApiContext } from './api'
import { App } from './App'
import { ToastProvider } from './components/Toast'
import { fakeApi, type FakeApiOptions } from './test/fake-api'

async function renderApp(options: FakeApiOptions = {}) {
  const fake = fakeApi(options)
  const user = userEvent.setup()
  const writeText = vi.fn((_text: string) => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  render(
    <ApiContext value={fake.api}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ApiContext>,
  )
  await screen.findByText('v0.1.0')
  // The picker lists what is ready, once the connection checks are in.
  if (!options.configured || options.configured.includes('codex-subscription'))
    await screen.findByRole('option', { name: 'Codex · ChatGPT' })
  return { ...fake, user, writeText }
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

const codex = { provider: 'codex-subscription', state: 'ready', message: 'Signed in' } as const

const allowance = (
  overrides: Partial<ProviderAllowance> = {},
): ProviderResult<ProviderAllowance> => ({
  ok: true,
  value: {
    provider: 'codex-subscription',
    plan: 'Plus',
    state: 'available',
    resetsAt: null,
    windows: [],
    lastError: null,
    ...overrides,
  },
})

const models = (overrides: Partial<ProviderModels> = {}): ProviderResult<ProviderModels> => ({
  ok: true,
  value: {
    provider: 'codex-subscription',
    options: [
      {
        id: 'gpt-a',
        label: 'GPT A',
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
        isDefault: true,
      },
      {
        id: 'gpt-b',
        label: 'GPT B',
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
        isDefault: false,
      },
    ],
    selectedModel: 'gpt-a',
    savedModel: null,
    defaultModel: 'gpt-a',
    resolvedModel: null,
    ...overrides,
  },
})

/** A finished turn; events arrive in separate renders, as they do from main. */
function finishedConversation(pushChat: (event: ChatEvent) => void): void {
  act(() => {
    pushChat({ type: 'run_started', runId: 'r1', text: 'List my files' })
    pushChat({ type: 'text_delta', runId: 'r1', turn: 1, text: 'Here are **files**.' })
  })
  act(() => {
    pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'end_turn' })
  })
}

describe('message actions', () => {
  it('copies user and assistant messages and announces it', async () => {
    const { user, pushChat, writeText } = await renderApp()
    finishedConversation(pushChat)
    const messages = screen.getByRole('list', { name: 'Messages' })
    const [first, second] = within(messages).getAllByRole('button', { name: 'Copy message' })
    await user.click(first as HTMLElement)
    expect(writeText).toHaveBeenLastCalledWith('List my files')
    await user.click(second as HTMLElement)
    // The assistant's raw Markdown, not rendered text.
    expect(writeText).toHaveBeenLastCalledWith('Here are **files**.')
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('Copied')
  })

  it('retries the last user message when idle, and disables Retry while busy', async () => {
    const { api, user, pushChat } = await renderApp()
    finishedConversation(pushChat)
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry).toHaveProperty('disabled', false)
    await user.click(retry)
    expect(api.chat.send).toHaveBeenCalledWith('List my files')

    act(() => {
      pushChat({ type: 'run_started', runId: 'r2', text: 'List my files' })
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveProperty('disabled', true)
  })

  it('offers Retry on one message only', async () => {
    const { pushChat } = await renderApp()
    finishedConversation(pushChat)
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
  })
})

describe('streaming indicator', () => {
  it('shows animated dots with a text label while running', async () => {
    const { pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
    })
    const progress = screen.getByText('Claude · API is working…').closest('li')
    expect(progress?.querySelectorAll('.typing-dots span')).toHaveLength(3)
  })
})

describe('activity group', () => {
  it('groups consecutive tool calls into one collapsible block', async () => {
    const { user, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Go' })
      for (const id of ['t1', 't2', 't3']) {
        pushChat({
          type: 'tool_use',
          runId: 'r1',
          turn: 1,
          id,
          name: 'list_dir',
          input: { path: id },
        })
      }
      pushChat({
        type: 'tool_result',
        runId: 'r1',
        id: 't1',
        content: 'ok',
        isError: false,
        declined: false,
      })
      pushChat({
        type: 'tool_result',
        runId: 'r1',
        id: 't2',
        content: 'ok',
        isError: false,
        declined: false,
      })
    })
    expect(screen.getAllByRole('region', { name: 'Tool activity' })).toHaveLength(1)
    // One still runs: open, and says so.
    const toggle = screen.getByRole('button', { name: /Using 3 tools/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    act(() => {
      pushChat({
        type: 'tool_result',
        runId: 'r1',
        id: 't3',
        content: 'ok',
        isError: false,
        declined: false,
      })
      pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'end_turn' })
    })
    const done = screen.getByRole('button', { name: /Used 3 tools/ })
    expect(done.getAttribute('aria-expanded')).toBe('false')
    await user.click(done)
    expect(done.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByText('done')).toHaveLength(3)
  })

  it('splits groups around assistant text and opens one with a failure', async () => {
    const { pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Go' })
      pushChat({ type: 'tool_use', runId: 'r1', turn: 1, id: 'a', name: 'read_file', input: {} })
      pushChat({
        type: 'tool_result',
        runId: 'r1',
        id: 'a',
        content: 'x',
        isError: true,
        declined: false,
      })
      pushChat({ type: 'text_delta', runId: 'r1', turn: 2, text: 'Then' })
      pushChat({ type: 'tool_use', runId: 'r1', turn: 2, id: 'b', name: 'read_file', input: {} })
      pushChat({
        type: 'tool_result',
        runId: 'r1',
        id: 'b',
        content: 'x',
        isError: false,
        declined: false,
      })
      pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'end_turn' })
    })
    expect(screen.getAllByRole('region', { name: 'Tool activity' })).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: /Used 1 tool.*1 failed/ }).getAttribute('aria-expanded'),
    ).toBe('true')
  })
})

describe('Escape', () => {
  it('stops a running reply', async () => {
    const { api, user, pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
    })
    await user.keyboard('{Escape}')
    expect(api.chat.stop).toHaveBeenCalledOnce()
  })

  it('does nothing when idle', async () => {
    const { api, user } = await renderApp()
    await user.keyboard('{Escape}')
    expect(api.chat.stop).not.toHaveBeenCalled()
  })

  it('denies the approval and does not stop the run when a dialog is open', async () => {
    const { api, user, pushChat, pushApproval } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
    })
    const prompt: ApprovalPrompt = {
      id: 'a1',
      runId: 'r1',
      toolUseId: 't1',
      tool: 'write_file',
      kind: 'write',
      summary: 'Write C:\\x.txt',
      detail: '+x\n',
    }
    act(() => {
      pushApproval(prompt)
    })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(api.approvals.respond).toHaveBeenCalledWith('a1', false)
    expect(api.chat.stop).not.toHaveBeenCalled()
  })
})

describe('Escape with Settings', () => {
  const prompt: ApprovalPrompt = {
    id: 'a1',
    runId: 'r1',
    toolUseId: 't1',
    tool: 'write_file',
    kind: 'write',
    summary: 'Write C:\\x.txt',
    detail: '+x\n',
  }

  it('denies an approval first, closes Settings next, and only then stops the reply', async () => {
    const { api, user, pushChat, pushApproval } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hi' })
    })
    await user.keyboard('{Control>},{/Control}')
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()

    // 1. An approval pauses Settings; Escape denies it and leaves Settings and the run alone.
    act(() => {
      pushApproval(prompt)
    })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(api.approvals.respond).toHaveBeenCalledWith('a1', false)
    expect(api.chat.stop).not.toHaveBeenCalled()
    act(() => {
      pushChat({ type: 'approval_closed', approvalId: 'a1', approved: false })
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()

    // 2. Settings open: Escape closes it and does not stop the running reply.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    expect(api.chat.stop).not.toHaveBeenCalled()

    // 3. Neither open: Escape stops the running reply.
    await user.keyboard('{Escape}')
    expect(api.chat.stop).toHaveBeenCalledOnce()
  })
})

describe('Settings and the composer share state', () => {
  it('switches provider from Settings through chat.switchProvider and updates the composer', async () => {
    const { api, user } = await renderApp()
    await user.keyboard('{Control>},{/Control}')
    await user.click(await screen.findByRole('button', { name: /Use Codex · ChatGPT/ }))
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('codex-subscription')
    })
    expect(screen.getByRole('combobox', { name: 'Active provider', hidden: true })).toHaveProperty(
      'value',
      'codex-subscription',
    )
  })

  it('opens Settings at Accounts & usage from the usage indicator', async () => {
    const fake = fakeApi({ provider: codex })
    fake.api.provider.allowance.mockResolvedValue(allowance({ state: 'limited' }))
    const user = userEvent.setup()
    render(
      <ApiContext value={fake.api}>
        <App />
      </ApiContext>,
    )
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    await user.click(await screen.findByRole('button', { name: /Limit reached/ }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Usage' })).toBeTruthy()
  })
})

describe('composer pickers', () => {
  it('switches provider through the existing switch path, clearing the conversation', async () => {
    const { api, user, pushChat } = await renderApp()
    finishedConversation(pushChat)
    expect(screen.getByText('List my files')).toBeTruthy()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active provider' }),
      'codex-subscription',
    )
    expect(api.provider.set).toHaveBeenCalledWith('codex-subscription')
    await waitFor(() => {
      expect(screen.queryByText('List my files')).toBeNull()
    })
    // The sidebar no longer has its own provider select.
    expect(screen.getAllByRole('combobox', { name: 'Active provider' })).toHaveLength(1)
  })

  it('keeps the pickers in the composer', async () => {
    await renderApp()
    const composer = screen.getByRole('textbox', { name: 'Message' }).closest('form') as HTMLElement
    expect(within(composer).getByRole('combobox', { name: 'Active provider' })).toBeTruthy()
  })

  it('lists Codex models and saves a choice or the account default', async () => {
    const { api, user } = await renderApp({ provider: codex })
    api.provider.models.mockResolvedValue(models())
    api.provider.setModel.mockResolvedValue(models({ savedModel: 'gpt-b' }))
    // Provider is Codex from the start; reopen the list after the mock is in place.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active provider' }),
      'claude-subscription',
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active provider' }),
      'codex-subscription',
    )
    const picker = await screen.findByRole('combobox', { name: 'Model' })
    await user.selectOptions(picker, 'gpt-b')
    expect(api.provider.setModel).toHaveBeenLastCalledWith('gpt-b')
    await user.selectOptions(picker, '')
    expect(api.provider.setModel).toHaveBeenLastCalledWith(null)
  })

  it('says "Using default model" when the resolved model is not the saved one', async () => {
    const { api, user } = await renderApp()
    api.provider.models.mockResolvedValue(
      models({ savedModel: 'gpt-gone', resolvedModel: 'gpt-a' }),
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active provider' }),
      'codex-subscription',
    )
    expect(await screen.findByText('Using default model')).toBeTruthy()
    // The unavailable saved model is not shown as selected.
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveProperty('value', '')
  })

  it('hides the model picker when the provider has no list (Claude subscription)', async () => {
    const { api, user } = await renderApp()
    api.provider.models.mockResolvedValue(models({ provider: 'claude-subscription', options: [] }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active provider' }),
      'claude-subscription',
    )
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalled()
    })
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull()
  })

  it('uses the existing model API for Anthropic API mode', async () => {
    const { api, user } = await renderApp()
    const picker = await screen.findByRole('combobox', { name: 'Model' })
    expect(within(picker).queryByRole('option', { name: 'Default model' })).toBeNull()
    await user.selectOptions(picker, 'claude-opus-5-5')
    expect(api.model.set).toHaveBeenCalledWith('claude-opus-5-5')
    expect(api.provider.setModel).not.toHaveBeenCalled()
  })
})

describe('usage indicator', () => {
  it('shows nothing for unknown allowance', async () => {
    await renderApp({ provider: codex })
    expect(screen.queryByRole('button', { name: /Open account settings/ })).toBeNull()
  })

  it('turns amber at 80% and opens account settings on click', async () => {
    const fake = fakeApi({ provider: codex })
    fake.api.provider.allowance.mockResolvedValue(
      allowance({
        windows: [
          {
            limitId: 'codex:secondary',
            remainingPercent: 18,
            resetsAt: null,
            label: 'weekly limit',
          },
        ],
      }),
    )
    const user = userEvent.setup()
    render(
      <ApiContext value={fake.api}>
        <App />
      </ApiContext>,
    )
    const chip = await screen.findByRole('button', { name: /82% of weekly limit used/ })
    expect(chip.className).toContain('usage-warning')
    await user.click(chip)
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()
  })

  it('shows a limit with its reset, and never blocks sending', async () => {
    const fake = fakeApi({ provider: codex })
    fake.api.provider.allowance.mockResolvedValue(
      allowance({ state: 'limited', resetsAt: new Date(Date.now() + 3_600_000).toISOString() }),
    )
    const user = userEvent.setup()
    render(
      <ApiContext value={fake.api}>
        <App />
      </ApiContext>,
    )
    const chip = await screen.findByRole('button', { name: /Limit reached – resets/ })
    expect(chip.className).toContain('usage-limited')
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'still try{Enter}')
    expect(fake.api.chat.send).toHaveBeenCalledWith('still try')
  })

  it('refreshes on provider switch, after a turn, and on a usage-limit error', async () => {
    const { api, user, pushChat } = await renderApp({ provider: codex })
    await waitFor(() => {
      expect(api.provider.allowance).toHaveBeenCalledTimes(1)
    })
    finishedConversation(pushChat)
    await waitFor(() => {
      expect(api.provider.allowance).toHaveBeenCalledTimes(2)
    })
    act(() => {
      pushChat({ type: 'run_started', runId: 'r2', text: 'again' })
      pushChat({ type: 'error', runId: 'r2', code: 'usage_limit', message: 'Limit reached.' })
    })
    await waitFor(() => {
      expect(api.provider.allowance).toHaveBeenCalledTimes(3)
    })
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active provider' }),
      'claude-subscription',
    )
    await waitFor(() => {
      expect(api.provider.allowance.mock.calls.length).toBeGreaterThanOrEqual(4)
    })
  })

  it('ignores an allowance that belongs to another provider', async () => {
    const fake = fakeApi({ provider: codex })
    fake.api.provider.allowance.mockResolvedValue(
      allowance({ provider: 'claude-subscription', state: 'limited' }),
    )
    render(
      <ApiContext value={fake.api}>
        <App />
      </ApiContext>,
    )
    await screen.findByText('v0.1.0')
    await waitFor(() => {
      expect(fake.api.provider.allowance).toHaveBeenCalled()
    })
    expect(screen.queryByRole('button', { name: /Limit reached/ })).toBeNull()
  })
})

describe('keyboard shortcuts', () => {
  it('Ctrl+N starts a new chat', async () => {
    const { api, user } = await renderApp()
    await user.keyboard('{Control>}n{/Control}')
    expect(api.chat.newChat).toHaveBeenCalledOnce()
  })

  it('Ctrl+, opens Settings, and Ctrl+K returns to the chat and focuses the composer', async () => {
    const { user } = await renderApp()
    await user.keyboard('{Control>},{/Control}')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()
    await user.keyboard('{Control>}k{/Control}')
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }))
    })
  })

  it('Cmd+K works too, and shortcuts are off while an approval is open', async () => {
    const { api, user, pushApproval } = await renderApp()
    act(() => {
      pushApproval({
        id: 'a1',
        runId: 'r1',
        toolUseId: 't1',
        tool: 'write_file',
        kind: 'write',
        summary: 'Write C:\\x.txt',
        detail: '+x\n',
      })
    })
    await user.keyboard('{Control>}n{/Control}')
    expect(api.chat.newChat).not.toHaveBeenCalled()
  })
})
