import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem, ChatState, HistoryState } from '../../shared/ipc'
import type { ProviderChat } from '../../shared/ipc-projects'
import { ApiContext } from './api'
import { App } from './App'
import { fakeApi, type FakeApiOptions } from './test/fake-api'
import { setViewport } from './test/viewport'

const now = Date.now()
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CLAUDE = 'claude-subscription'
const CODEX = 'codex-subscription'

const chat = (
  provider: string,
  id: string,
  title: string,
  age: number,
  extra: object = {},
): ProviderChat => ({ provider, id, title, createdAt: now - age, updatedAt: now - age, ...extra })

const chats: ProviderChat[] = [
  chat(CLAUDE, A, 'Plan the release', 0),
  chat(CODEX, B, 'Fix the flaky test', 1000, { lastConnection: CODEX }),
  chat('ollama', C, 'Local notes', 2000),
]
const history: HistoryState = {
  conversations: chats.filter((c) => c.provider === CLAUDE),
  activeId: A,
  active: { provider: CLAUDE, id: A },
  chats,
}
const reply = (id: string, text: string, connection?: string, model?: string): ChatItem => ({
  kind: 'assistant',
  id,
  text,
  ...(connection ? { connection } : {}),
  ...(model ? { model } : {}),
})
const saved = (items: ChatItem[], h: HistoryState = history): ChatState => ({
  items,
  running: false,
  loadError: null,
  history: h,
})

afterEach(() => {
  localStorage.clear()
})

async function renderApp(options: FakeApiOptions = {}) {
  setViewport(1280)
  const fake = fakeApi({
    history,
    provider: { provider: CLAUDE, state: 'ready', message: 'Ready.' },
    chat: saved([
      { kind: 'user', id: 'u1', text: 'Question one' },
      reply('a1', 'Answer one', CLAUDE, 'opus'),
    ]),
    ...options,
  })
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <App />
    </ApiContext>,
  )
  await screen.findByText('v0.1.0')
  await screen.findByRole('button', { name: 'Plan the release' })
  return { ...fake, user }
}

const nav = () =>
  within(screen.getByRole('complementary', { name: 'Conversations' })).getByRole('navigation', {
    name: 'Chats',
  })
const row = (title: string) => within(nav()).getByRole('button', { name: title })

describe('one list for every connection', () => {
  it('lists chats of all connections with the connection that last answered', async () => {
    await renderApp()
    expect(row('Plan the release').closest('li')?.textContent).toContain('Claude')
    // lastConnection wins; a chat with none shows its home.
    expect(row('Fix the flaky test').closest('li')?.textContent).toContain('Codex')
    expect(row('Local notes').closest('li')?.textContent).toContain('Ollama')
    expect(row('Plan the release').getAttribute('aria-current')).toBe('page')
    expect(row('Fix the flaky test').getAttribute('aria-current')).toBeNull()
  })

  it('shows a connection main no longer lists as plain text', async () => {
    await renderApp({
      history: {
        ...history,
        chats: [...chats, chat('gone‮-conn', 'orphan-id', 'Orphan chat', 3000)],
      },
    })
    const badge = row('Orphan chat').closest('li')?.querySelector('.chat-provider')
    expect(badge?.textContent).toBe('gone-conn')
  })

  it('marks the open chat by home and id, not id alone', async () => {
    await renderApp({
      history: {
        ...history,
        active: { provider: CODEX, id: A },
        chats: [...chats, chat(CODEX, A, 'Same id elsewhere', 4000)],
      },
    })
    expect(row('Same id elsewhere').getAttribute('aria-current')).toBe('page')
    expect(row('Plan the release').getAttribute('aria-current')).toBeNull()
  })

  it('opens another connection’s chat without switching the connection', async () => {
    const { api, user } = await renderApp()
    await user.click(row('Fix the flaky test'))
    expect(api.chats.open).toHaveBeenCalledWith({ provider: CODEX, id: B })
    expect(api.provider.set).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Active provider' })).toHaveProperty(
      'value',
      CLAUDE,
    )
  })
})

describe('switching connection with a chat open', () => {
  const switchTo = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByRole('option', { name: 'Codex · ChatGPT' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Active provider' }), CODEX)
  }
  const pending = (api: Awaited<ReturnType<typeof renderApp>>['api']) => {
    let finish: () => void = () => {}
    let fail: () => void = () => {}
    api.provider.set.mockImplementationOnce(
      (next) =>
        new Promise((resolve, reject) => {
          finish = () => {
            resolve({ provider: next, state: 'ready', message: 'Ready.' })
          }
          fail = () => {
            reject(new Error('nope'))
          }
        }),
    )
    return {
      finish: () => {
        finish()
      },
      fail: () => {
        fail()
      },
    }
  }

  it('keeps the chat and the list on screen, disables input, then continues the same chat', async () => {
    const fake = await renderApp()
    const { api, user, pushChat } = fake
    const control = pending(api)
    await switchTo(user)
    expect(api.provider.set).toHaveBeenCalledWith(CODEX)
    expect(screen.getByText('Answer one')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Switching to Codex · ChatGPT…')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('readOnly', true)
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
    expect(row('Fix the flaky test')).toBeTruthy()
    expect(row('Plan the release').getAttribute('aria-current')).toBe('page')

    // A chat opened meanwhile waits: opening is refused while the switch is in progress.
    await user.click(row('Local notes'))
    expect(api.chats.open).not.toHaveBeenCalled()

    // History changes (any connection) apply live, mid-switch.
    act(() => {
      pushChat({
        type: 'history_changed',
        history: {
          ...history,
          chats: chats.map((c) => (c.id === B ? { ...c, title: 'Renamed elsewhere' } : c)),
        },
      })
    })
    expect(row('Renamed elsewhere')).toBeTruthy()
    expect(screen.getByText('Answer one')).toBeTruthy()

    // Main's reset for the same chat ends it, with the reply now attributed to the new connection.
    act(() => {
      pushChat({
        type: 'conversation_reset',
        state: saved([
          { kind: 'user', id: 'u1', text: 'Question one' },
          reply('a1', 'Answer one', CLAUDE, 'opus'),
          { kind: 'user', id: 'u2', text: 'Question two' },
          reply('a2', 'Answer two', CODEX, 'gpt-5.5'),
        ]),
      })
    })
    expect(screen.getByText('Answer two')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => {
      control.finish()
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('readOnly', false)
    expect(screen.getByText('Answer two')).toBeTruthy()
  })

  it('ignores a reset for a different chat while switching', async () => {
    const { api, user, pushChat } = await renderApp()
    const control = pending(api)
    await switchTo(user)
    act(() => {
      pushChat({
        type: 'conversation_reset',
        state: saved([{ kind: 'user', id: 'x', text: 'Other chat entirely' }], {
          ...history,
          active: { provider: CODEX, id: B },
        }),
      })
    })
    expect(screen.queryByText('Other chat entirely')).toBeNull()
    expect(screen.getByText('Answer one')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/^Switching to/)
    await act(async () => {
      control.finish()
      await Promise.resolve()
    })
  })

  it('restores cleanly when the switch fails: same chat, input enabled, list intact', async () => {
    const { api, user } = await renderApp()
    const control = pending(api)
    await switchTo(user)
    await act(async () => {
      control.fail()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull()
    })
    expect(screen.getByText('Answer one')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('readOnly', false)
    expect(row('Plan the release').getAttribute('aria-current')).toBe('page')
    expect(row('Local notes')).toBeTruthy()
  })

  it('New chat starts on the current connection and clears the screen', async () => {
    const { api, user } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect(api.chat.newChat).toHaveBeenCalled()
    expect(api.provider.set).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByText('Answer one')).toBeNull()
    })
  })
})

describe('per-message provider badges', () => {
  const badges = () =>
    [...document.querySelectorAll('.message-assistant .message-badge')].map((el) => el.textContent)

  it('badges the first reply and each change of connection or model, as plain text', async () => {
    await renderApp({
      chat: saved([
        { kind: 'user', id: 'u1', text: 'one' },
        reply('a1', 'r1', CLAUDE, 'opus'),
        { kind: 'user', id: 'u2', text: 'two' },
        reply('a2', 'r2', CLAUDE, 'opus'),
        { kind: 'user', id: 'u3', text: 'three' },
        reply('a3', 'r3', CODEX, 'gpt-5.5'),
        { kind: 'user', id: 'u4', text: 'four' },
        reply('a4', 'r4', CODEX, 'gpt-5.5'),
        { kind: 'user', id: 'u5', text: 'five' },
        reply('a5', 'r5', CODEX, 'gpt-6‮<b>x</b>'),
      ]),
    })
    expect(badges()).toEqual([
      'Claude · Subscriptionopus',
      'Codex · ChatGPTgpt-5.5',
      'Codex · ChatGPTgpt-6<b>x</b>',
    ])
    expect(document.querySelector('.message-badge b')).toBeNull()
    // Replies without a badge still name who wrote them.
    const authors = [...document.querySelectorAll('.message-assistant .message-author')]
    expect(authors).toHaveLength(5)
  })

  it('gives no badge to replies saved before provenance was recorded', async () => {
    await renderApp({
      chat: saved([
        { kind: 'user', id: 'u1', text: 'one' },
        reply('a1', 'old reply'),
        { kind: 'user', id: 'u2', text: 'two' },
        reply('a2', 'new reply', CODEX, 'gpt-5.5'),
      ]),
    })
    expect(badges()).toEqual(['Codex · ChatGPTgpt-5.5'])
  })

  it('stamps a streamed reply with the connection it ran on', async () => {
    const { pushChat } = await renderApp({ chat: saved([]) })
    act(() => {
      pushChat({ type: 'run_started', runId: 'r1', text: 'Hello' })
      pushChat({ type: 'text_delta', runId: 'r1', turn: 1, text: 'Streaming' })
    })
    expect(badges()).toEqual(['Claude · Subscription'])
  })
})
