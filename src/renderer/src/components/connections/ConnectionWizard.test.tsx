import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ApprovalPrompt, ProviderStatus } from '../../../../shared/ipc'
import { ApiContext } from '../../api'
import { App } from '../../App'
import { ALL_CONNECTION_INFO } from '../../../../shared/extra-connections-fixture'
import { fakeApi, type FakeApiOptions } from '../../test/fake-api'
import { setViewport } from '../../test/viewport'

const signedOut = (provider: string): ProviderStatus => ({
  provider,
  state: 'signed-out',
  message: 'Sign in with your subscription.',
})

/** Nothing is set up: no key, and every connection reports it is not ready. */
const NOTHING_READY: FakeApiOptions = {
  key: { saved: false, error: null },
  connections: ALL_CONNECTION_INFO,
  statuses: Object.fromEntries(ALL_CONNECTION_INFO.map((info) => [info.id, signedOut(info.id)])),
  provider: { provider: 'anthropic-api', state: 'ready', message: 'API mode' },
}

/** A user who has a key and all the connections listed, so the wizard stays closed. */
const SET_UP: FakeApiOptions = { connections: ALL_CONNECTION_INFO }

async function renderApp(options: FakeApiOptions) {
  setViewport(1280)
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

const wizard = (name: string | RegExp) => screen.findByRole('dialog', { name })
const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  name: string | RegExp,
) => {
  await user.click(within(dialog).getByRole('button', { name }))
}

describe('first run', () => {
  it('opens when nothing is ready, offers every provider, and can be skipped', async () => {
    const { user, api } = await renderApp(NOTHING_READY)
    const dialog = await wizard('Which AI do you want to use?')
    expect(
      within(dialog).getAllByRole('button', {
        name: /^(Claude|ChatGPT|Gemini|Local models|OpenRouter)/,
      }),
    ).toHaveLength(5)
    expect(within(dialog).getByText('Ollama or LM Studio, runs on this PC')).toBeTruthy()
    expect(within(dialog).getByText('Many models, one key')).toBeTruthy()
    expect(within(dialog).getByText('You can add more later and switch any time.')).toBeTruthy()
    // The heading takes focus so a screen reader starts at the question.
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { level: 2 }))
    await user.click(within(dialog).getByRole('button', { name: 'Skip for now' }))
    expect(screen.queryByRole('dialog', { name: 'Which AI do you want to use?' })).toBeNull()
    // Skipping changes nothing in the app's settings.
    expect(api.provider.set).not.toHaveBeenCalled()
    expect(api.connections.remove).not.toHaveBeenCalled()
  })

  it('stays closed when a connection is ready', async () => {
    await renderApp(SET_UP)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the subscription path', () => {
  it('signs in, skips the model list with an explanation, grants a folder and finishes', async () => {
    const { user, api } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Claude/)

    dialog = await wizard('How do you want to use Claude?')
    const segments = within(dialog).getByRole('radiogroup', { name: 'Access type' })
    expect(
      within(segments)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['free', 'subscription', 'api-key'])
    // Subscription is the first available segment, with its cost line.
    expect(within(dialog).getByText('Uses your plan’s limits. No API charges.')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))

    dialog = await wizard('Sign in to Claude')
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('claude-subscription')
    })
    await user.click(await within(dialog).findByRole('button', { name: 'Sign in' }))
    await waitFor(() => {
      expect(api.provider.login).toHaveBeenCalledOnce()
    })
    expect(await within(dialog).findByText('Connected')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))

    // Claude's subscription has no model list: the step explains instead of hiding.
    dialog = await wizard('Pick a model')
    expect(within(dialog).getByText(/chooses the model for you/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))

    dialog = await wizard('Choose a folder to work in')
    expect(within(dialog).getByText('C:\\Users\\me\\Projects')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))

    dialog = await wizard('You’re all set')
    expect(within(dialog).getByRole('status').textContent).toBe(
      'You’re set up with Claude · Subscription · the default model.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Start chatting' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // The new connection is the one in use.
    expect(screen.getByRole('combobox', { name: 'Active provider' })).toHaveProperty(
      'value',
      'claude-subscription',
    )
  })

  it('offers a folder when none is granted yet, and lets the user skip', async () => {
    const { user, api } = await renderApp({
      ...NOTHING_READY,
      grants: { roots: [], loadError: null },
    })
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Claude/)
    dialog = await wizard('How do you want to use Claude?')
    await user.click(within(dialog).getByRole('radio', { name: /API key/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Add your Anthropic API key')
    await user.type(within(dialog).getByLabelText('Anthropic API key'), 'sk-ant-xyz')
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Continue' }))
    dialog = await wizard('Pick a model')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Choose a folder to work in')
    await user.click(within(dialog).getByRole('button', { name: 'Choose a folder…' }))
    expect(api.grants.add).toHaveBeenCalledOnce()
    expect(await within(dialog).findByText('D:\\Docs')).toBeTruthy()
  })
})

describe('the API key path', () => {
  async function toGeminiKey(options: FakeApiOptions = NOTHING_READY) {
    const app = await renderApp(options)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(app.user, dialog, /^Gemini/)
    dialog = await wizard('How do you want to use Gemini?')
    await app.user.click(within(dialog).getByRole('radio', { name: /API key/ }))
    await app.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Add your Gemini API key')
    return { ...app, dialog }
  }

  it('shows the free-key notice and a Get a key link, saves through main and shows no key', async () => {
    const { user, api, dialog } = await toGeminiKey()
    expect(within(dialog).getByRole('note').textContent).toMatch(/Free Gemini keys may let Google/)
    const link = within(dialog).getByRole('link', { name: 'Get a key' })
    expect(link.getAttribute('href')).toBe('https://aistudio.google.com/app/apikey')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    const field = within(dialog).getByLabelText('Gemini API key')
    expect(field.getAttribute('type')).toBe('password')
    await user.type(field, 'AIza-secret-key')
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))
    expect(api.apiKey.set).toHaveBeenCalledExactlyOnceWith('AIza-secret-key', 'gemini-api')
    expect(
      await within(dialog).findByText(
        'Key saved and encrypted by Windows. It can’t be viewed again.',
      ),
    ).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('AIza-secret-key')
    // The field is gone: a saved key is never shown, or editable, again.
    expect(within(dialog).queryByLabelText('Gemini API key')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Replace key' })).toBeTruthy()
  })

  it("shows main's validation error and stays on the key step", async () => {
    const { user, api, dialog } = await toGeminiKey()
    api.apiKey.set.mockResolvedValueOnce({ saved: false, error: 'That key was not accepted.' })
    await user.type(within(dialog).getByLabelText('Gemini API key'), 'bad')
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That key was not accepted.',
    )
    expect(within(dialog).queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('lists models with a Recommended badge, saves the choice, and warns about local models', async () => {
    const { user, api, dialog } = await toGeminiKey()
    api.provider.models.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        value: {
          provider: 'gemini-api',
          options: [
            {
              id: 'g1',
              label: 'Gemini One',
              defaultReasoningEffort: null,
              supportedReasoningEfforts: [],
              isDefault: false,
            },
            {
              id: 'g2',
              label: 'Gemini Two',
              defaultReasoningEffort: null,
              supportedReasoningEfforts: [],
              isDefault: true,
            },
          ],
          selectedModel: null,
          savedModel: null,
          defaultModel: 'g2',
          resolvedModel: 'g2',
        },
      }),
    )
    api.provider.setModel.mockImplementation((model) =>
      Promise.resolve({
        ok: true,
        value: {
          provider: 'gemini-api',
          options: [],
          selectedModel: model,
          savedModel: model,
          defaultModel: 'g2',
          resolvedModel: model,
        },
      }),
    )
    await user.type(within(dialog).getByLabelText('Gemini API key'), 'AIza-x')
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Continue' }))
    const models = await wizard('Pick a model')
    const group = await within(models).findByRole('radiogroup', { name: 'Model' })
    const two = within(group).getByRole('radio', { name: /Gemini Two/ })
    expect(within(two.closest('label') as HTMLElement).getByText('Recommended')).toBeTruthy()
    expect(within(group).getByRole('radio', { name: /Gemini One/ })).toHaveProperty(
      'checked',
      false,
    )
    expect(two).toHaveProperty('checked', true)
    expect(within(models).queryByText(/Smaller local models/)).toBeNull()
    await user.click(within(group).getByRole('radio', { name: /Gemini One/ }))
    expect(api.provider.setModel).toHaveBeenCalledWith('g1')
  })
})

describe('local models', () => {
  it('says the server is not running, checks again, and warns about small models', async () => {
    const { user, api } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    expect(within(dialog).getAllByRole('radio')).toHaveLength(1)
    expect(within(dialog).getByText('Runs on this PC. No account needed.')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))

    // Two local apps: the user says which one.
    dialog = await wizard('Which one do you use?')
    api.provider.set.mockResolvedValueOnce({
      provider: 'ollama',
      state: 'error',
      message: 'Ollama is not running at 127.0.0.1:11434. Start it, then check again.',
    })
    await choose(user, dialog, /^Ollama/)
    dialog = await wizard('Find Ollama')
    expect(await within(dialog).findByText(/Ollama is not running/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Continue' })).toBeNull()

    api.provider.models.mockResolvedValue({
      ok: true,
      value: {
        provider: 'ollama',
        options: [
          {
            id: 'qwen',
            label: 'qwen3:8b',
            defaultReasoningEffort: null,
            supportedReasoningEfforts: [],
            isDefault: true,
          },
        ],
        selectedModel: null,
        savedModel: null,
        defaultModel: 'qwen',
        resolvedModel: 'qwen',
      },
    })
    api.provider.get.mockResolvedValueOnce({
      provider: 'ollama',
      state: 'ready',
      message: 'Ready.',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Check again' }))
    expect(await within(dialog).findByText('Connected')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))

    dialog = await wizard('Pick a model')
    expect(
      await within(dialog).findByText('Smaller local models may not use file tools reliably.'),
    ).toBeTruthy()
    expect(within(dialog).getByText('Recommended')).toBeTruthy()
  })
})

describe('combinations that do not work', () => {
  it('keeps them visible and disabled with the reason, and points to the next step', async () => {
    const { user } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Gemini/)
    dialog = await wizard('How do you want to use Gemini?')
    const free = within(dialog).getByRole('radio', { name: /Free/ })
    const subscription = within(dialog).getByRole('radio', { name: /Subscription/ })
    expect(free.getAttribute('aria-disabled')).toBe('true')
    expect(subscription.getAttribute('aria-disabled')).toBe('true')
    // The API key segment is the available one and is chosen first.
    expect(within(dialog).getByRole('radio', { name: /API key/ })).toHaveProperty('checked', true)
    await user.click(free)
    const reason =
      'Google doesn’t allow other apps to use your Google sign-in for Gemini. Use a free Gemini API key from Google AI Studio instead.'
    expect(within(dialog).getByText(reason)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toHaveProperty(
      'disabled',
      true,
    )
    await user.click(subscription)
    expect(within(dialog).getByText(reason)).toBeTruthy()
    // The next step is one click away: the API key segment.
    await user.click(within(dialog).getByRole('button', { name: 'Use a Gemini API key' }))
    expect(within(dialog).getByRole('radio', { name: /API key/ })).toHaveProperty('checked', true)
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toHaveProperty(
      'disabled',
      false,
    )
  })

  it('explains Claude Free and links to the API key', async () => {
    const { user } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Claude/)
    dialog = await wizard('How do you want to use Claude?')
    await user.click(within(dialog).getByRole('radio', { name: /Free/ }))
    expect(within(dialog).getByText(/Claude Free doesn’t include Claude Code/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Use an Anthropic API key' }))
    expect(within(dialog).getByRole('radio', { name: /API key/ })).toHaveProperty('checked', true)
  })

  it('hides the Claude subscription when personal-use connections are off', async () => {
    const { user } = await renderApp({
      ...NOTHING_READY,
      connections: ALL_CONNECTION_INFO,
      showPersonalUse: false,
    })
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Claude/)
    dialog = await wizard('How do you want to use Claude?')
    expect(
      within(dialog)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['free', 'api-key'])
  })
})

describe('keyboard, Back and focus', () => {
  it('goes back with Esc and Back, and closes from the first step', async () => {
    const { user } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^ChatGPT/)
    dialog = await wizard('How do you want to use ChatGPT?')
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { level: 2 }))
    await user.keyboard('{Escape}')
    dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^ChatGPT/)
    dialog = await wizard('How do you want to use ChatGPT?')
    await user.click(within(dialog).getByRole('button', { name: 'Back' }))
    dialog = await wizard('Which AI do you want to use?')
    expect(within(dialog).queryByRole('button', { name: 'Back' })).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves between access types with the arrow keys', async () => {
    const { user } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^ChatGPT/)
    dialog = await wizard('How do you want to use ChatGPT?')
    within(dialog).getByRole('radio', { name: /Free/ }).focus()
    await user.keyboard('{ArrowRight}')
    expect(within(dialog).getByRole('radio', { name: /Subscription/ })).toHaveProperty(
      'checked',
      true,
    )
    await user.keyboard('{ArrowRight}')
    expect(within(dialog).getByRole('radio', { name: /API key/ })).toHaveProperty('checked', true)
  })

  it('keeps Tab inside the dialog', async () => {
    const { user } = await renderApp(NOTHING_READY)
    const dialog = await wizard('Which AI do you want to use?')
    for (let press = 0; press < 12; press++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    for (let press = 0; press < 12; press++) {
      await user.tab({ shift: true })
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('puts back the connection chats went to when the user cancels at the connect step', async () => {
    const { user, api } = await renderApp({
      ...NOTHING_READY,
      configured: ['anthropic-api'],
    })
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^ChatGPT/)
    dialog = await wizard('How do you want to use ChatGPT?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Sign in to ChatGPT')
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('codex-subscription')
    })
    await within(dialog).findByRole('button', { name: 'Sign in' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(api.provider.set).toHaveBeenLastCalledWith('anthropic-api')
    // It was only added for this attempt, so it is taken out again.
    expect(api.connections.remove).toHaveBeenCalledWith('codex-subscription')
    expect(api.provider.cancelLogin).toHaveBeenCalled()
  })
})

describe('with an approval', () => {
  const prompt: ApprovalPrompt = {
    id: 'a1',
    runId: 'r1',
    toolUseId: 't1',
    tool: 'write_file',
    kind: 'write',
    summary: 'Write C:\\x.txt',
    detail: '+x\n',
  }

  it('hides behind the approval, which Esc denies first', async () => {
    const { user, api, pushApproval } = await renderApp(NOTHING_READY)
    const dialog = await wizard('Which AI do you want to use?')
    act(() => {
      pushApproval(prompt)
    })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    const overlay = dialog.closest('.wizard-overlay') as HTMLElement
    expect(overlay.hidden).toBe(true)
    expect(overlay.hasAttribute('inert')).toBe(true)
    await user.keyboard('{Escape}')
    expect(api.approvals.respond).toHaveBeenCalledWith('a1', false)
    // The wizard is still there, and still its own: nothing closed it.
    expect(
      screen.getByRole('dialog', { name: 'Which AI do you want to use?', hidden: true }),
    ).toBeTruthy()
  })
})

describe('untrusted text', () => {
  it('renders connection labels, errors and model names as plain text', async () => {
    const hostile = '<img src=x onerror="alert(1)">'
    const connections = ALL_CONNECTION_INFO.map((info) =>
      info.id === 'ollama' ? { ...info, title: hostile, description: hostile } : info,
    )
    const { user, api } = await renderApp({
      ...NOTHING_READY,
      connections,
      statuses: Object.fromEntries(connections.map((info) => [info.id, signedOut(info.id)])),
    })
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Which one do you use?')
    expect(within(dialog).getAllByText(hostile).length).toBeGreaterThan(0)
    api.provider.set.mockResolvedValueOnce({
      provider: 'ollama',
      state: 'error',
      message: '<b>not running</b>',
    })
    await user.click(within(dialog).getAllByText(hostile)[0]?.closest('button') as HTMLElement)
    dialog = await wizard(/^Find /)
    expect(await within(dialog).findByText('<b>not running</b>')).toBeTruthy()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(dialog.querySelector('b')).toBeNull()
  })
})
