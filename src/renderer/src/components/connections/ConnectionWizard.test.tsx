import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalPrompt, ProviderStatus } from '../../../../shared/ipc'
import { ApiContext } from '../../api'
import { App } from '../../App'
import { ConnectionOverviewProvider, ConnectionsProvider } from '../../connections'
import { SwitchQueue } from '../../switch-queue'
import { ConnectionWizard } from './ConnectionWizard'
import { BUILTIN_CONNECTION_INFO } from '../../../../shared/connections-fixture'
import { fakeApi, type FakeApiOptions } from '../../test/fake-api'
import { setViewport } from '../../test/viewport'

// The wait on main is real time, so a test that ran into it would pass or fail with the
// runner's speed. It never runs out here (2^31 - 1 ms, the longest setTimeout), so closing
// waits for the undo as it does in practice. Only 'closing never hangs on main' shortens it,
// to test what happens when it runs out.
const timing = vi.hoisted(() => ({ ms: 2 ** 31 - 1 }))
const NEVER_MS = timing.ms
vi.mock('./timing', async (original) => ({
  ...(await original<typeof import('./timing')>()),
  get SETTLE_WAIT_MS() {
    return timing.ms
  },
}))

const signedOut = (provider: string): ProviderStatus => ({
  provider,
  state: 'signed-out',
  message: 'Sign in with your subscription.',
})

/** Nothing is set up: no key, and every connection reports it is not ready. */
const NOTHING_READY: FakeApiOptions = {
  key: { saved: false, error: null },
  connections: BUILTIN_CONNECTION_INFO,
  statuses: Object.fromEntries(
    BUILTIN_CONNECTION_INFO.map((info) => [info.id, signedOut(info.id)]),
  ),
  provider: { provider: 'anthropic-api', state: 'ready', message: 'API mode' },
}

/** A user who has a key and all the connections listed, so the wizard stays closed. */
const SET_UP: FakeApiOptions = { connections: BUILTIN_CONNECTION_INFO }

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
/**
 * Waits for the step's heading to take focus. A wizard opened by a load from main can be on
 * screen before its effects (the focus, the Esc and Tab handling) have run.
 */
const headingFocused = (dialog: HTMLElement) =>
  waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { level: 2 }))
  })
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
    await headingFocused(dialog)
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

describe('the ChatGPT plan path', () => {
  const PLAN_MODELS = [
    {
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      isDefault: true,
    },
  ]

  async function toPlanSignIn(options: FakeApiOptions = NOTHING_READY) {
    const app = await renderApp(options)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(app.user, dialog, /^ChatGPT/)
    dialog = await wizard('How do you want to use ChatGPT?')
    const segments = within(dialog).getByRole('radiogroup', { name: 'Access type' })
    expect(
      within(segments)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['free', 'subscription', 'plan', 'api-key'])
    await app.user.click(within(dialog).getByRole('radio', { name: /Plan/ }))
    expect(
      within(dialog).getByText(
        'Documented for ChatGPT Plus and Pro. On other plans, use Subscription (Codex).',
      ),
    ).toBeTruthy()
    await app.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Sign in with ChatGPT')
    await waitFor(() => {
      expect(app.api.provider.set).toHaveBeenCalledWith('chatgpt-plan')
    })
    return { ...app, dialog }
  }

  /** provider.login() waits, as main does for the browser, until the test settles it. */
  function pendingLogin(app: Awaited<ReturnType<typeof toPlanSignIn>>) {
    let settle!: (status: ProviderStatus) => void
    app.api.provider.login.mockImplementationOnce(
      () =>
        new Promise<ProviderStatus>((resolve) => {
          app.pushLoginState({ provider: 'chatgpt-plan', active: true, url: null, result: null })
          settle = (status) => {
            app.pushLoginState({ provider: null, active: false, url: null, result: status })
            resolve(status)
          }
        }),
    )
    return (status: ProviderStatus) => {
      act(() => {
        settle(status)
      })
    }
  }

  it('signs in with ChatGPT, waits, cancels, signs in again and finishes', async () => {
    const app = await toPlanSignIn()
    const { user, api, dialog } = app
    expect(within(dialog).getByText(/Plus or Pro plan/)).toBeTruthy()
    const button = await within(dialog).findByRole('button', { name: 'Continue with ChatGPT' })
    // The hook the official button artwork replaces.
    expect(button.getAttribute('data-sign-in')).toBe('chatgpt')
    // No link or code to paste: main waits on its own loopback listener.
    expect(within(dialog).queryByRole('button', { name: 'Sign in' })).toBeNull()

    const settle = pendingLogin(app)
    await user.click(button)
    expect(
      await within(dialog).findByText(
        'Waiting for you to finish signing in to ChatGPT in your browser…',
      ),
    ).toBeTruthy()
    expect(within(dialog).queryByLabelText('Sign-in link')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Continue with ChatGPT' })).toHaveProperty(
      'disabled',
      true,
    )
    await user.click(within(dialog).getByRole('button', { name: 'Cancel sign-in' }))
    expect(api.provider.cancelLogin).toHaveBeenCalledOnce()
    settle({ provider: 'chatgpt-plan', state: 'error', message: 'Sign-in cancelled.' })
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Sign-in cancelled.')
    // Still on the connect step, and the cancelled attempt switched nobody away.
    expect(screen.getByRole('dialog', { name: 'Sign in with ChatGPT' })).toBeTruthy()

    await user.click(within(dialog).getByRole('button', { name: 'Continue with ChatGPT' }))
    expect(await within(dialog).findByText('Connected')).toBeTruthy()
    api.provider.models.mockResolvedValue({
      ok: true,
      value: {
        provider: 'chatgpt-plan',
        options: PLAN_MODELS,
        selectedModel: 'gpt-6.1-sol',
        savedModel: null,
        defaultModel: 'gpt-6.1-sol',
        resolvedModel: 'gpt-6.1-sol',
      },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    let next = await wizard('Pick a model')
    expect(await within(next).findByRole('radio', { name: /GPT-6.1 Sol/ })).toBeTruthy()
    await user.click(within(next).getByRole('button', { name: 'Continue' }))
    next = await wizard('Choose a folder to work in')
    await user.click(within(next).getByRole('button', { name: 'Continue' }))
    next = await wizard('You’re all set')
    expect(within(next).getByRole('status').textContent).toBe(
      'You’re set up with ChatGPT · Plan · GPT-6.1 Sol.',
    )
  })

  it('closing while it waits cancels the sign-in and puts back the connection chats went to', async () => {
    const app = await toPlanSignIn({ ...NOTHING_READY, configured: ['anthropic-api'] })
    const { user, api, dialog } = app
    const settle = pendingLogin(app)
    await user.click(await within(dialog).findByRole('button', { name: 'Continue with ChatGPT' }))
    await within(dialog).findByRole('button', { name: 'Cancel sign-in' })
    api.provider.cancelLogin.mockImplementationOnce(() => {
      settle({ provider: 'chatgpt-plan', state: 'error', message: 'Sign-in cancelled.' })
      return Promise.resolve()
    })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(api.provider.cancelLogin).toHaveBeenCalled()
    expect(api.provider.set).toHaveBeenLastCalledWith('anthropic-api')
    expect(api.connections.remove).toHaveBeenCalledWith('chatgpt-plan')
  })

  it('leaves Codex for ChatGPT Free and Subscription', async () => {
    const { user, api } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^ChatGPT/)
    dialog = await wizard('How do you want to use ChatGPT?')
    await user.click(within(dialog).getByRole('radio', { name: /Subscription/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Sign in to ChatGPT')
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('codex-subscription')
    })
    expect(await within(dialog).findByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Continue with ChatGPT' })).toBeNull()
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
    expect(within(dialog).getByRole('note').textContent).toMatch(
      /Free Gemini API keys share your data with Google/,
    )
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

describe('closing never hangs on main', () => {
  // A short wait, so these tests of main never answering finish quickly.
  beforeEach(() => {
    timing.ms = 60
  })
  afterEach(() => {
    timing.ms = NEVER_MS
  })
  const never = <T,>(): Promise<T> => new Promise<T>(() => {})
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  const ready = (provider: string): ProviderStatus => ({
    provider,
    state: 'ready',
    message: 'Ready.',
  })
  async function toOllama() {
    const result = await renderApp(NOTHING_READY)
    const { user } = result
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Which one do you use?')
    return { ...result, dialog }
  }
  const gone = () =>
    waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull()
      },
      { timeout: 2000 },
    )

  it('closes when the switch never answers, and undoes it if it lands later', async () => {
    const { user, api, dialog } = await toOllama()
    const late = deferred<ProviderStatus>()
    api.provider.set.mockClear()
    api.provider.set.mockImplementationOnce(() => late.promise)
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('ollama')
    })
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await gone()
    expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual(['ollama'])
    // The switch lands after the wizard is gone, with nobody else having chosen: put back.
    api.provider.get.mockResolvedValue(ready('ollama'))
    act(() => {
      late.resolve(ready('ollama'))
    })
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenLastCalledWith('anthropic-api')
    })
    expect(api.connections.remove).toHaveBeenCalledWith('ollama')
  })

  it('leaves a connection the user chose themselves alone when the late switch lands', async () => {
    const { user, api, dialog } = await toOllama()
    const late = deferred<ProviderStatus>()
    api.provider.set.mockClear()
    api.provider.set.mockImplementationOnce(() => late.promise)
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('ollama')
    })
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await gone()
    // The user has picked another connection since.
    api.provider.get.mockResolvedValue(ready('codex-subscription'))
    act(() => {
      late.resolve(ready('ollama'))
    })
    await new Promise((done) => setTimeout(done, 150))
    expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual(['ollama'])
    expect(api.connections.remove).not.toHaveBeenCalled()
  })

  it('closes when the first read never answers, and switches nothing', async () => {
    const { user, api, dialog } = await toOllama()
    api.provider.get.mockImplementationOnce(() => never<ProviderStatus>())
    api.provider.set.mockClear()
    await choose(user, dialog, /^Ollama/)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await gone()
    await new Promise((done) => setTimeout(done, 150))
    expect(api.provider.set).not.toHaveBeenCalled()
  })

  it('does not wait for a key-status lookup that never answers', async () => {
    const { user, api, dialog } = await toOllama()
    api.apiKey.status.mockImplementation(() => never<{ saved: boolean; error: string | null }>())
    api.provider.set.mockClear()
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('ollama')
    })
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await gone()
    // The switch had landed, so it is undone on the spot.
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenLastCalledWith('anthropic-api')
    })
    expect(api.connections.remove).toHaveBeenCalledWith('ollama')
  })

  /** Ollama chosen, its switch left pending, then Back to the local-app list. */
  async function backOutMidSwitch() {
    const result = await toOllama()
    const { user, api, dialog } = result
    const first = deferred<ProviderStatus>()
    api.provider.set.mockClear()
    api.provider.set.mockImplementationOnce(() => first.promise)
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('ollama')
    })
    await user.keyboard('{Escape}')
    const access = await wizard('How do you want to use Local models?')
    await user.click(within(access).getByRole('button', { name: 'Continue' }))
    return { ...result, first, apps: await wizard('Which one do you use?') }
  }
  const pastTheBound = () => new Promise((done) => setTimeout(done, 200))

  it('keeps a re-pick waiting past the bound, with no second switch, until the first settles', async () => {
    const { user, api, first, apps } = await backOutMidSwitch()
    await choose(user, apps, /^LM Studio/)
    const waiting = await wizard('Find LM Studio')
    expect(await within(waiting).findByText('Finishing the previous connection…')).toBeTruthy()
    // Well past the wait Close would give: still exactly one switch in flight.
    await pastTheBound()
    expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual(['ollama'])
    expect(within(waiting).getByText('Finishing the previous connection…')).toBeTruthy()
    // Back and Close still answer while it waits.
    expect(within(waiting).getByRole('button', { name: 'Close' })).toBeTruthy()

    api.provider.get.mockResolvedValue(ready('ollama'))
    act(() => {
      first.resolve(ready('ollama'))
    })
    // Only now does the second pick switch, and the abandoned run restores nothing.
    await waitFor(() => {
      expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual(['ollama', 'lmstudio'])
    })
    await pastTheBound()
    expect(api.provider.set).not.toHaveBeenCalledWith('anthropic-api')
    expect(api.connections.remove).not.toHaveBeenCalled()
  })

  it('re-picking the same connection finds it switched and does not restore the old one', async () => {
    const { user, api, first, apps } = await backOutMidSwitch()
    await choose(user, apps, /^Ollama/)
    const waiting = await wizard('Find Ollama')
    await pastTheBound()
    expect(api.provider.set).toHaveBeenCalledTimes(1)
    api.provider.get.mockResolvedValue(ready('ollama'))
    act(() => {
      first.resolve(ready('ollama'))
    })
    expect(await within(waiting).findByText('Connected')).toBeTruthy()
    await pastTheBound()
    expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual(['ollama'])
    expect(api.connections.remove).not.toHaveBeenCalled()
  })

  it('does not put the old connection back over a choice made in the picker meanwhile', async () => {
    // Connections are ready, so the wizard is opened from the composer's picker.
    const { user, api } = await renderApp(SET_UP)
    const picker = await screen.findByRole('combobox', { name: 'Active provider' })
    await within(picker).findByRole('option', { name: 'Codex · ChatGPT' })
    await user.selectOptions(picker, 'Add or manage connections…')
    api.provider.set.mockClear()
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Which one do you use?')
    const first = deferred<ProviderStatus>()
    api.provider.set.mockImplementationOnce(() => first.promise)
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('ollama')
    })
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await gone()
    // The undo is queued behind the switch. The picker is locked while a switch runs; once it
    // lands, the undo checks where chats are (held open here) and the user picks Codex.
    const check = deferred<ProviderStatus>()
    api.provider.get.mockImplementationOnce(() => check.promise)
    act(() => {
      first.resolve(ready('ollama'))
    })
    await waitFor(() => {
      expect(api.provider.get).toHaveBeenCalled()
    })
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active provider' }),
      'codex-subscription',
    )
    // The check finishes: chats are on Ollama, but the user has chosen since, so it is left alone.
    act(() => {
      check.resolve(ready('ollama'))
    })
    await waitFor(() => {
      expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual([
        'ollama',
        'codex-subscription',
      ])
    })
    await pastTheBound()
    expect(api.connections.remove).not.toHaveBeenCalled()
  })
})

describe('an undo that goes stale while its restoring switch is running', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  const ready = (provider: string): ProviderStatus => ({
    provider,
    state: 'ready',
    message: 'Ready.',
  })
  const pastTheBound = () => new Promise((done) => setTimeout(done, 200))

  it('keeps the added connection and shows nothing of the undo when the user chose meanwhile', async () => {
    setViewport(1280)
    const fake = fakeApi(NOTHING_READY)
    const { api } = fake
    const queue = new SwitchQueue()
    const restore = deferred<ProviderStatus>()
    const onProvider = vi.fn()
    const onClose = vi.fn()
    // The wizard's switch to Ollama lands at once; the switch back is held open.
    const onSwitchProvider = vi.fn((id: string) =>
      id === 'ollama' ? Promise.resolve(ready('ollama')) : restore.promise,
    )
    const user = userEvent.setup()
    render(
      <ApiContext value={api}>
        <ConnectionsProvider>
          <ConnectionOverviewProvider>
            <ConnectionWizard
              suspended={false}
              firstRun={false}
              startAt="ollama"
              grants={{ roots: [], loadError: null }}
              onGrants={() => {}}
              onProvider={onProvider}
              queue={queue}
              onSwitchProvider={onSwitchProvider}
              onClose={onClose}
            />
          </ConnectionOverviewProvider>
        </ConnectionsProvider>
      </ApiContext>,
    )
    await screen.findByRole('dialog', { name: 'Find Ollama' })
    await waitFor(() => {
      expect(onSwitchProvider).toHaveBeenCalledWith('ollama')
    })
    // Chats are on Ollama now.
    api.provider.get.mockResolvedValue(ready('ollama'))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(onSwitchProvider).toHaveBeenCalledWith('anthropic-api')
    })
    // The user chooses something while the restoring switch is still running.
    queue.choose()
    act(() => {
      restore.resolve(ready('anthropic-api'))
    })
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
    await pastTheBound()
    expect(api.connections.remove).not.toHaveBeenCalled()
    // The panel may report Ollama's own status; the undo's restored status is never shown.
    expect(onProvider).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic-api' }),
    )
  })

  it('keeps it too when a newer wizard run starts during the restoring switch', async () => {
    setViewport(1280)
    const { user, api } = await (async () => {
      const result = await renderApp(NOTHING_READY)
      return result
    })()
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Which one do you use?')
    const first = deferred<ProviderStatus>()
    const restore = deferred<ProviderStatus>()
    api.provider.set.mockClear()
    api.provider.set.mockImplementationOnce(() => first.promise)
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('ollama')
    })
    // Back (the undo waits behind the switch), then forward to the list of local apps.
    await user.keyboard('{Escape}')
    const access = await wizard('How do you want to use Local models?')
    await user.click(within(access).getByRole('button', { name: 'Continue' }))
    const apps = await wizard('Which one do you use?')
    api.provider.get.mockResolvedValue(ready('ollama'))
    api.provider.set.mockImplementationOnce(() => restore.promise)
    act(() => {
      first.resolve(ready('ollama'))
    })
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('anthropic-api')
    })
    // A newer run starts while the restoring switch is still in flight.
    await choose(user, apps, /^Ollama/)
    act(() => {
      restore.resolve(ready('anthropic-api'))
    })
    const find = await wizard('Find Ollama')
    await pastTheBound()
    expect(api.connections.remove).not.toHaveBeenCalled()
    expect(find).toBeTruthy()
  })
})

describe('each run keeps its own undo state', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  const ready = (provider: string): ProviderStatus => ({
    provider,
    state: 'ready',
    message: 'Ready.',
  })

  it('undoes a different target against the session baseline and removes only its own connection', async () => {
    const { user, api } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Which one do you use?')
    api.provider.set.mockClear()
    // Run A: Ollama. It lands (chats are on Ollama, which it added).
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.apiKey.status).toHaveBeenCalledWith('ollama')
    })
    // Back: A's undo starts, and its switch back to the baseline is held open.
    const restore = deferred<ProviderStatus>()
    api.provider.set.mockImplementationOnce(() => restore.promise)
    await user.keyboard('{Escape}')
    const access = await wizard('How do you want to use Local models?')
    await user.click(within(access).getByRole('button', { name: 'Continue' }))
    const apps = await wizard('Which one do you use?')
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenLastCalledWith('anthropic-api')
    })
    // Run B, a different target, starts while A's restore is in flight.
    await choose(user, apps, /^LM Studio/)
    act(() => {
      restore.resolve(ready('anthropic-api'))
    })
    await within(await wizard('Find LM Studio')).findByRole('button', { name: 'Check again' })
    // A's undo went stale: Ollama was neither removed nor shown. B switched on its own.
    expect(api.connections.remove).not.toHaveBeenCalled()
    expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual([
      'ollama',
      'anthropic-api',
      'lmstudio',
    ])
    // B's undo returns to the session baseline (not to Ollama) and removes only LM Studio.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    await waitFor(() => {
      expect(api.connections.remove).toHaveBeenCalledWith('lmstudio')
    })
    expect(api.connections.remove).toHaveBeenCalledTimes(1)
    expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual([
      'ollama',
      'anthropic-api',
      'lmstudio',
      'anthropic-api',
    ])
  })
})

describe('text a server supplies', () => {
  it('shows model names and status messages without bidi or invisible characters', async () => {
    const RLO = String.fromCharCode(0x202e)
    const ZWSP = String.fromCharCode(0x200b)
    const { user, api } = await renderApp(NOTHING_READY)
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Which one do you use?')
    api.provider.set.mockResolvedValueOnce({
      provider: 'ollama',
      state: 'error',
      message: `Ollama${RLO} is not${ZWSP} running.\nStart it, then check again.`,
    })
    await choose(user, dialog, /^Ollama/)
    dialog = await wizard('Find Ollama')
    const note = await within(dialog).findByText(/is not running/)
    expect(note.textContent).toBe('Ollama is not running. Start it, then check again.')

    api.provider.models.mockResolvedValue({
      ok: true,
      value: {
        provider: 'ollama',
        options: [
          {
            id: 'qwen',
            label: `qwen${RLO}3:8b${ZWSP}`,
            defaultReasoningEffort: null,
            supportedReasoningEfforts: [],
            isDefault: true,
          },
        ],
        selectedModel: null,
        savedModel: null,
        defaultModel: 'qwen',
        resolvedModel: 'qwen',
        warning: `Ollama${RLO} doesn’t say which models use tools.`,
      },
    })
    api.provider.get.mockResolvedValueOnce({
      provider: 'ollama',
      state: 'ready',
      message: 'Ready.',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Check again' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Continue' }))
    dialog = await wizard('Pick a model')
    expect(await within(dialog).findByText('qwen3:8b')).toBeTruthy()
    expect(within(dialog).getByText('Ollama doesn’t say which models use tools.')).toBeTruthy()
    expect(dialog.textContent).not.toContain(RLO)
    expect(dialog.textContent).not.toContain(ZWSP)
  })
})

describe('cancelling while the connect step is still getting ready', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  const ready = (provider: string): ProviderStatus => ({
    provider,
    state: 'ready',
    message: 'Ready.',
  })

  async function toOllama() {
    const result = await renderApp(NOTHING_READY)
    const { user } = result
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Which one do you use?')
    return { ...result, dialog }
  }
  const settle = async () => {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20))
    })
  }

  it('never switches after the wizard is closed while provider.get() is pending', async () => {
    const { user, api, dialog } = await toOllama()
    const get = deferred<ProviderStatus>()
    api.provider.get.mockImplementationOnce(() => get.promise)
    api.provider.set.mockClear()
    await choose(user, dialog, /^Ollama/)
    await wizard('Find Ollama')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    // The read finishes after the wizard was closed.
    act(() => {
      get.resolve(ready('anthropic-api'))
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Ollama|Which/ })).toBeNull()
    })
    await settle()
    expect(api.provider.set).not.toHaveBeenCalled()
    expect(api.connections.remove).not.toHaveBeenCalled()
  })

  it('finishes a switch that was already started, then restores the previous connection', async () => {
    const { user, api, dialog } = await toOllama()
    const toOllamaSwitch = deferred<ProviderStatus>()
    api.provider.set.mockClear()
    api.provider.set.mockImplementationOnce(() => toOllamaSwitch.promise)
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('ollama')
    })
    await user.click(screen.getByRole('button', { name: 'Close' }))
    // Nothing is put back until the switch that is in flight has landed.
    await settle()
    expect(api.provider.set).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Find Ollama' })).toBeTruthy()
    // Once it lands, chats are on Ollama.
    api.provider.get.mockResolvedValue(ready('ollama'))
    act(() => {
      toOllamaSwitch.resolve(ready('ollama'))
    })
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenLastCalledWith('anthropic-api')
    })
    expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual(['ollama', 'anthropic-api'])
    // The half-added connection is dropped again.
    expect(api.connections.remove).toHaveBeenCalledWith('ollama')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    await settle()
    expect(api.provider.set).toHaveBeenCalledTimes(2)
  })

  it('puts the previous connection back when Back is pressed mid-switch', async () => {
    const { user, api, dialog } = await toOllama()
    const slow = deferred<ProviderStatus>()
    api.provider.set.mockClear()
    api.provider.set.mockImplementationOnce(() => slow.promise)
    await choose(user, dialog, /^Ollama/)
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenCalledWith('ollama')
    })
    await user.keyboard('{Escape}')
    api.provider.get.mockResolvedValue(ready('ollama'))
    act(() => {
      slow.resolve(ready('ollama'))
    })
    await waitFor(() => {
      expect(api.provider.set).toHaveBeenLastCalledWith('anthropic-api')
    })
    // Back at the previous step, with the previous connection in place.
    expect(await wizard('How do you want to use Local models?')).toBeTruthy()
    expect(api.provider.set.mock.calls.map(([id]) => id)).toEqual(['ollama', 'anthropic-api'])
  })
})

describe('the local server address (Advanced)', () => {
  async function toFindOllama() {
    const result = await renderApp(NOTHING_READY)
    const { user, api } = result
    let dialog = await wizard('Which AI do you want to use?')
    await choose(user, dialog, /^Local models/)
    dialog = await wizard('How do you want to use Local models?')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    dialog = await wizard('Which one do you use?')
    api.provider.set.mockResolvedValueOnce({
      provider: 'ollama',
      state: 'error',
      message: 'Ollama is not running at 127.0.0.1:11434. Start it, then check again.',
    })
    await choose(user, dialog, /^Ollama/)
    dialog = await wizard('Find Ollama')
    await within(dialog).findByText(/Ollama is not running/)
    await user.click(within(dialog).getByText('Advanced'))
    return { ...result, dialog }
  }

  it('refuses an address that is not on this PC, with the reason from main', async () => {
    const { user, api, dialog } = await toFindOllama()
    expect(within(dialog).getByRole('textbox', { name: 'Server address' })).toHaveProperty(
      'placeholder',
      'http://127.0.0.1:11434/v1',
    )
    api.connections.setBaseUrl.mockResolvedValueOnce({
      baseUrl: 'http://127.0.0.1:11434/v1',
      custom: false,
      error: 'Only an address on this PC can be used.',
    })
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Server address' }),
      'http://192.168.1.20:11434/v1',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Save address' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Only an address on this PC can be used.',
    )
    expect(api.connections.setBaseUrl).toHaveBeenCalledWith(
      'ollama',
      'http://192.168.1.20:11434/v1',
    )
    // A refused address is not kept: no "usual address" button, and the server is not re-checked.
    expect(within(dialog).queryByRole('button', { name: 'Use the usual address' })).toBeNull()
  })

  it('saves a good address, looks for the server again, and can go back to the usual one', async () => {
    const { user, api, dialog } = await toFindOllama()
    api.provider.get.mockResolvedValueOnce({
      provider: 'ollama',
      state: 'ready',
      message: 'Ready.',
    })
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Server address' }),
      'http://localhost:9999/v1',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Save address' }))
    expect(await within(dialog).findByText('Connected')).toBeTruthy()
    expect(api.connections.setBaseUrl).toHaveBeenCalledWith('ollama', 'http://localhost:9999/v1')
    await user.click(await within(dialog).findByRole('button', { name: 'Use the usual address' }))
    expect(api.connections.setBaseUrl).toHaveBeenLastCalledWith('ollama', null)
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
      connections: BUILTIN_CONNECTION_INFO,
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
    expect(within(dialog).getByRole('radio', { name: /Plan/ })).toHaveProperty('checked', true)
    await user.keyboard('{ArrowRight}')
    expect(within(dialog).getByRole('radio', { name: /API key/ })).toHaveProperty('checked', true)
  })

  it('keeps Tab inside the dialog', async () => {
    const { user } = await renderApp(NOTHING_READY)
    const dialog = await wizard('Which AI do you want to use?')
    await headingFocused(dialog)
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
    const connections = BUILTIN_CONNECTION_INFO.map((info) =>
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
