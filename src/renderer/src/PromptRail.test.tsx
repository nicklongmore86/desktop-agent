import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalPrompt, ChatEvent } from '../../shared/ipc'
import { ApiContext } from './api'
import { App } from './App'
import { matchPromptHotkey } from './components/PromptRail'
import { ToastProvider } from './components/Toast'
import { fakeApi } from './test/fake-api'
import { setViewport } from './test/viewport'

async function renderApp() {
  const fake = fakeApi()
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ApiContext>,
  )
  await screen.findByText('v0.1.0')
  return { ...fake, user }
}

function converse(pushChat: (event: ChatEvent) => void, prompts: string[]): void {
  act(() => {
    prompts.forEach((text, index) => {
      const runId = `r${String(index)}`
      pushChat({ type: 'run_started', runId, text })
      pushChat({ type: 'text_delta', runId, turn: 1, text: `Reply ${String(index)}` })
      pushChat({ type: 'run_finished', runId, stopReason: 'end_turn' })
    })
  })
}

const ticks = (): HTMLElement[] => screen.queryAllByRole('button', { name: /^Jump to prompt/ })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('prompt rail', () => {
  it('is hidden with fewer than two prompts and shows one button per prompt after', async () => {
    const { pushChat } = await renderApp()
    expect(screen.queryByRole('navigation', { name: 'Prompts' })).toBeNull()
    converse(pushChat, ['First question'])
    expect(ticks()).toHaveLength(0)
    act(() => {
      pushChat({ type: 'run_started', runId: 'r9', text: 'Second\nquestion' })
    })
    const buttons = ticks()
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Jump to prompt 1 of 2: First question',
      'Jump to prompt 2 of 2: Second question',
    ])
  })

  it('is hidden below 760px', async () => {
    const { pushChat } = await renderApp()
    converse(pushChat, ['One', 'Two'])
    expect(ticks()).toHaveLength(2)
    act(() => {
      setViewport(700)
    })
    expect(ticks()).toHaveLength(0)
  })

  it('previews the prompt as plain text on hover', async () => {
    const { pushChat, user } = await renderApp()
    converse(pushChat, ['<b>bold</b> one', 'Two'])
    await user.hover(ticks()[0] as HTMLElement)
    const nav = screen.getByRole('navigation', { name: 'Prompts' })
    const preview = nav.querySelector('.prompt-preview')
    expect(preview?.textContent).toBe('<b>bold</b> one')
    expect(preview?.querySelector('b')).toBeNull()
    await user.unhover(ticks()[0] as HTMLElement)
    expect(nav.querySelector('.prompt-preview')).toBeNull()
  })

  it('scrolls to the prompt and flashes it, but not under reduced motion', async () => {
    const { pushChat, user } = await renderApp()
    converse(pushChat, ['One', 'Two'])
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const row = (): Element | null =>
      screen.getByRole('list', { name: 'Messages' }).querySelector('[data-prompt-id]')
    const reduce = (matches: boolean): void => {
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          }) as unknown as MediaQueryList,
      )
    }
    reduce(true)
    await user.click(ticks()[0] as HTMLElement)
    expect(scroll).toHaveBeenLastCalledWith({ block: 'center', behavior: 'auto' })
    expect(row()?.hasAttribute('data-flash')).toBe(false)

    reduce(false)
    await user.click(ticks()[0] as HTMLElement)
    expect(scroll).toHaveBeenLastCalledWith({ block: 'center', behavior: 'smooth' })
    expect(row()?.hasAttribute('data-flash')).toBe(true)
  })

  it('steps between prompts with Ctrl+Alt+Up and Down, and not while an approval is open', async () => {
    const { pushChat, pushApproval } = await renderApp()
    converse(pushChat, ['One', 'Two', 'Three'])
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const press = (code: string, init: KeyboardEventInit = {}): void => {
      fireEvent.keyDown(document.body, { code, ctrlKey: true, altKey: true, ...init })
    }
    // jsdom has no layout, so every prompt "starts" at 0: the last one is active.
    press('ArrowUp')
    expect(scroll).toHaveBeenCalledOnce()
    expect(ticks()[1]?.getAttribute('aria-current')).toBe('location')
    press('ArrowUp')
    expect(ticks()[0]?.getAttribute('aria-current')).toBe('location')
    press('ArrowDown')
    expect(ticks()[1]?.getAttribute('aria-current')).toBe('location')

    scroll.mockClear()
    press('ArrowDown', { repeat: true })
    expect(scroll).not.toHaveBeenCalled()

    act(() => {
      pushChat({ type: 'run_started', runId: 'rx', text: 'Four' })
    })
    const prompt: ApprovalPrompt = {
      id: 'a1',
      runId: 'rx',
      toolUseId: 't1',
      tool: 'write_file',
      kind: 'write',
      summary: 'Write C:\\x.txt',
      detail: '+x\n',
    }
    act(() => {
      pushApproval(prompt)
    })
    scroll.mockClear()
    press('ArrowUp')
    expect(scroll).not.toHaveBeenCalled()
  })
})

describe('matchPromptHotkey', () => {
  const base = {
    code: 'ArrowUp',
    ctrlKey: true,
    metaKey: false,
    altKey: true,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
  }
  it('matches the physical arrow keys with Ctrl or Cmd plus Alt', () => {
    expect(matchPromptHotkey(base)).toBe(-1)
    expect(matchPromptHotkey({ ...base, code: 'ArrowDown', ctrlKey: false, metaKey: true })).toBe(1)
  })
  it('ignores repeat, AltGraph, Shift, a missing modifier and handled events', () => {
    expect(matchPromptHotkey({ ...base, repeat: true })).toBeNull()
    expect(matchPromptHotkey({ ...base, getModifierState: (key) => key === 'AltGraph' })).toBeNull()
    expect(matchPromptHotkey({ ...base, shiftKey: true })).toBeNull()
    expect(matchPromptHotkey({ ...base, altKey: false })).toBeNull()
    expect(matchPromptHotkey({ ...base, ctrlKey: false })).toBeNull()
    expect(matchPromptHotkey({ ...base, defaultPrevented: true })).toBeNull()
    expect(matchPromptHotkey({ ...base, code: 'KeyA' })).toBeNull()
  })
})

describe('tool status', () => {
  const toolUse = (id: string): ChatEvent => ({
    type: 'tool_use',
    runId: 'r',
    turn: 1,
    id,
    name: 'write_file',
    input: { path: id },
  })

  it('counts elapsed time up while running, then freezes it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      const { pushChat } = await renderApp()
      act(() => {
        pushChat({ type: 'run_started', runId: 'r', text: 'Go' })
        pushChat(toolUse('t1'))
      })
      const card = (): HTMLElement =>
        screen.getByText('write_file').closest('details') as HTMLElement
      expect(within(card()).getByText('running')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(card().querySelector('.tool-elapsed')?.textContent).toBe('3.0s')
      act(() => {
        pushChat({ type: 'tool_result', runId: 'r', id: 't1', content: 'ok', isError: false })
      })
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(card().querySelector('.tool-elapsed')?.textContent).toBe('3.0s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells queued, failed and denied calls apart', async () => {
    const { pushChat, pushApproval } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r', text: 'Go' })
      for (const id of ['q', 'f', 'd']) pushChat(toolUse(id))
      pushChat({ type: 'tool_result', runId: 'r', id: 'f', content: 'boom', isError: true })
      pushChat({
        type: 'tool_result',
        runId: 'r',
        id: 'd',
        content: 'The user declined the write to x. Nothing was changed.',
        isError: true,
      })
      pushApproval({
        id: 'a',
        runId: 'r',
        toolUseId: 'q',
        tool: 'write_file',
        kind: 'write',
        summary: 's',
        detail: null,
      })
    })
    const group = screen.getByRole('region', { name: 'Tool activity' })
    expect(within(group).getByText('queued')).toBeTruthy()
    expect(within(group).getByText('failed')).toBeTruthy()
    expect(within(group).getByText('denied')).toBeTruthy()
    expect(within(group).getByRole('button', { name: /1 failed/ })).toBeTruthy()
  })

  it('keeps the newest three steps while streaming, but never hides a failure', async () => {
    const { pushChat, user } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r', text: 'Go' })
      for (const id of ['a', 'b', 'c', 'd', 'e']) pushChat(toolUse(id))
      for (const id of ['a', 'b', 'c', 'd'])
        pushChat({ type: 'tool_result', runId: 'r', id, content: 'ok', isError: id === 'b' })
    })
    const group = screen.getByRole('region', { name: 'Tool activity' })
    const cards = (): string[] =>
      within(group)
        .getAllByText('write_file')
        .map((name) => name.closest('details')?.textContent ?? '')
    // a is folded; b failed so it stays; c, d, e are the newest three.
    expect(cards()).toHaveLength(4)
    await user.click(within(group).getByRole('button', { name: 'Show 1 earlier step' }))
    expect(cards()).toHaveLength(5)
  })

  it('folds an earlier turn under "Worked for", open only if a call failed', async () => {
    const { pushChat, user } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r', text: 'One' })
      pushChat(toolUse('t1'))
      pushChat({ type: 'tool_result', runId: 'r', id: 't1', content: 'ok', isError: false })
      pushChat({ type: 'run_finished', runId: 'r', stopReason: 'end_turn' })
    })
    // The latest turn is never folded.
    expect(screen.queryByRole('button', { name: /Worked/ })).toBeNull()
    act(() => {
      pushChat({ type: 'run_started', runId: 's', text: 'Two' })
    })
    const fold = screen.getByRole('button', { name: /^Worked for / })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    await user.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /Used 1 tool/ })).toBeTruthy()
  })

  it('has a single polite live region for the work status', async () => {
    const { pushChat } = await renderApp()
    act(() => {
      pushChat({ type: 'run_started', runId: 'r', text: 'Go' })
      pushChat(toolUse('t1'))
      pushChat({ type: 'run_started', runId: 'r', text: 'Go' })
    })
    const messages = screen.getByRole('list', { name: 'Messages' })
    expect(messages.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(
      1,
    )
  })
})
