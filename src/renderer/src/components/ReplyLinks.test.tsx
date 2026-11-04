import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MentionResolution } from '../../../shared/ipc-files'
import { ApiContext } from '../api'
import { fakeApi } from '../test/fake-api'
import { Markdown, urlTransform } from './Markdown'
import { LinksSuspended } from './ReplyLinks'
import { ToastProvider } from './Toast'

const ROOT = 'C:\\Users\\Me\\Projects'
type Ok = Extract<MentionResolution, { ok: true }>
const NOTES: Ok = { ok: true, path: `${ROOT}\\notes.md`, kind: 'file', action: 'open' }
const SETUP: Ok = {
  ok: true,
  path: `${ROOT}\\setup.exe`,
  kind: 'file',
  action: 'reveal',
  note: 'Files of this type are not opened from a reply, because they could run code. It is shown in Explorer instead.',
}
const SRC: Ok = { ok: true, path: `${ROOT}\\src`, kind: 'dir', action: 'open' }
const MENTIONS: Record<string, Ok> = {
  [`${ROOT}\\notes.md`]: NOTES,
  [`${ROOT}\\setup.exe`]: SETUP,
  [`${ROOT}\\src`]: SRC,
  'docs/plan.md': { ...NOTES, path: `${ROOT}\\docs\\plan.md` },
  'notes.md': NOTES,
  'src/': SRC,
}

function renderReply(text: string, options: { suspended?: boolean } = {}) {
  const fake = fakeApi({ mentions: MENTIONS })
  const view = render(
    <ApiContext value={fake.api}>
      <ToastProvider>
        <LinksSuspended suspended={options.suspended ?? false}>
          <Markdown text={text} />
        </LinksSuspended>
      </ToastProvider>
    </ApiContext>,
  )
  return { fake, ...view }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('where a web link really goes', () => {
  it('shows the destination, as a description of the link, for hover and for focus', () => {
    renderReply('[the docs](https://example.com/docs?a=1)')
    const link = screen.getByRole('link', { name: 'the docs' })
    const hint = document.getElementById(link.getAttribute('aria-describedby') ?? '')
    expect(hint?.getAttribute('role')).toBe('tooltip')
    expect(hint?.textContent).toContain('https://example.com/docs?a=1')
    expect(hint?.textContent).toContain('Site: example.com')
    // CSS shows it on :hover and :focus-within (see components.css); it is in the DOM for both.
    expect(link.closest('.link-wrap')?.contains(hint)).toBe(true)
  })

  it('shows hidden, direction and look-alike characters as visible tokens, left to right', () => {
    renderReply(
      '[x](https://example.com/a%E2%80%AEb) [y](https://exаmple.com/) [z](https://a.test/\u202Efdp.exe)',
    )
    const hints = [...document.querySelectorAll('.link-dest')].map((el) => el.textContent)
    // A look-alike letter shows as a token, and the real (punycode) host is spelled out.
    expect(hints.join('\n')).toContain('⟨U+0430⟩')
    expect(hints.join('\n')).toContain('Site: xn--exmple-4nf.com')
    // The raw bidi override never reaches the page; it shows as ⟨U+202E⟩ in an LTR isolate.
    expect(document.body.textContent).not.toContain('\u202E')
    expect(hints.join('\n')).toContain('⟨U+202E⟩')
    for (const bdi of document.querySelectorAll('.link-dest bdi')) {
      expect(bdi.getAttribute('dir')).toBe('ltr')
      expect(bdi.className).toContain('untrusted')
    }
  })
})

describe('a link whose text names another site', () => {
  it('asks first, names the real destination, and does not open until confirmed', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const user = userEvent.setup()
    renderReply('[https://example.com/login](https://evil.test/steal)')
    await user.click(screen.getByRole('link'))
    expect(open).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByLabelText('Real destination').textContent).toBe(
      'https://evil.test/steal',
    )
    expect(dialog.textContent).toContain('https://example.com/login')
    expect(dialog.textContent).toContain('Site: evil.test')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    await user.click(screen.getByRole('link'))
    await user.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://evil.test/steal',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('cannot be opened around the question: Enter, middle click and Ctrl+click are held too', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const user = userEvent.setup()
    renderReply('[example.com](https://evil.test/)')
    const link = screen.getByRole('link')
    expect(
      fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })),
    ).toBe(false)
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    link.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })

  it('Escape cancels, and the dialog is hidden while an approval is showing', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ mentions: MENTIONS })
    const tree = (suspended: boolean) => (
      <ApiContext value={fake.api}>
        <ToastProvider>
          <LinksSuspended suspended={suspended}>
            <Markdown text="[example.com](https://evil.test/)" />
          </LinksSuspended>
        </ToastProvider>
      </ApiContext>
    )
    const { rerender } = render(tree(false))
    await user.click(screen.getByRole('link'))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    rerender(tree(true))
    expect(document.querySelector('.modal-backdrop')?.hasAttribute('hidden')).toBe(true)
    rerender(tree(false))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it.each([
    ['[example.com](https://example.com/page)'],
    ['[www.example.com](https://example.com/)'],
    ['[the docs](https://evil.test/)'],
    ['[README.md](https://github.com/x/y)'],
  ])('does not ask for %s', (text) => {
    renderReply(text)
    const link = screen.getByRole('link')
    expect(fireEvent.click(link)).toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('opens nothing while an approval is showing', () => {
    renderReply('[the docs](https://example.com/) [example.com](https://evil.test/)', {
      suspended: true,
    })
    for (const link of screen.getAllByRole('link')) expect(fireEvent.click(link)).toBe(false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('markdown safety is unchanged', () => {
  it('url transform: unsafe schemes are stripped, a drive path is kept only as data', () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,x',
      'file:///C:/Windows/win.ini',
      'vbscript:x',
      'C:evil',
    ])
      expect(urlTransform(url, 'href')).toBe('')
    expect(urlTransform('https://example.com/', 'href')).toBe('https://example.com/')
    expect(urlTransform('docs/a.md', 'href')).toBe('docs/a.md')
    expect(urlTransform('C:%5CUsers%5Ca.txt', 'href')).toBe('C:%5CUsers%5Ca.txt')
    expect(urlTransform('C:/Users/a.txt', 'href')).toBe('C:/Users/a.txt')
    // Only a link target is let through, never anything else (an image source, say).
    expect(urlTransform('C:/Users/a.txt', 'src')).toBe('')
  })

  it('keeps unsafe schemes stripped and never makes a file: URL a link', () => {
    const { container } = renderReply(
      '[a](javascript:alert(1)) [b](file:///C:/Windows/win.ini) [c](data:text/html,x) [d](mailto:x@y.z) [e](//evil.test/x) [f](#top)',
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[href]')).toBeNull()
  })

  it('never gives a path target an href, so nothing can navigate to it', async () => {
    const { container, fake } = renderReply(`[plan](docs/plan.md) [notes](${ROOT}\\notes.md)`)
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /plan|notes/ })).toHaveLength(2)
    })
    expect(container.querySelector('[href]')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(fake.api.files.resolveMentions).toHaveBeenCalled()
  })
})

describe('files and folders named in a reply', () => {
  it('is plain text until main says it is inside a granted folder', async () => {
    renderReply(`In ${ROOT}\\notes.md and ${ROOT}\\other.md and C:\\Windows\\notes.md.`)
    expect(await screen.findByRole('button', { name: `${ROOT}\\notes.md` })).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(document.body.textContent).toContain(`${ROOT}\\other.md`)
    expect(document.body.textContent).toContain('C:\\Windows\\notes.md')
  })

  it('describes what a click will do, with the full resolved path', async () => {
    renderReply(`\`${ROOT}\\notes.md\` and \`${ROOT}\\setup.exe\` and \`${ROOT}\\src\``)
    const buttons = await screen.findAllByRole('button')
    expect(buttons).toHaveLength(3)
    const hint = (button: HTMLElement | undefined) =>
      document.getElementById(button?.getAttribute('aria-describedby') ?? '')?.textContent
    expect(hint(buttons[0])).toBe(`Open${NOTES.path}`)
    expect(hint(buttons[1])).toContain('Show in Explorer')
    expect(hint(buttons[1])).toContain(SETUP.path)
    expect(hint(buttons[1])).toContain('not opened from a reply')
    expect(hint(buttons[2])).toBe(`Open folder${SRC.path}`)
  })

  it('opens an allowed file on click and says so', async () => {
    const user = userEvent.setup()
    const { fake } = renderReply(`Wrote \`${ROOT}\\notes.md\`.`)
    await user.click(await screen.findByRole('button', { name: `${ROOT}\\notes.md` }))
    expect(fake.api.files.openMention).toHaveBeenCalledExactlyOnceWith(`${ROOT}\\notes.md`)
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      expect.stringContaining('Opened notes.md'),
    )
  })

  it('says a program was shown in Explorer and not opened', async () => {
    const user = userEvent.setup()
    renderReply(`\`${ROOT}\\setup.exe\``)
    await user.click(await screen.findByRole('button'))
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('Shown in Explorer, not opened: setup.exe')
    expect(status.textContent).toContain('could run code')
  })

  it('works by keyboard', async () => {
    const user = userEvent.setup()
    const { fake } = renderReply(`\`${ROOT}\\notes.md\``)
    const button = await screen.findByRole('button')
    await user.tab()
    expect(document.activeElement).toBe(button)
    await user.keyboard('{Enter}')
    expect(fake.api.files.openMention).toHaveBeenCalledOnce()
    await user.keyboard(' ')
    expect(fake.api.files.openMention).toHaveBeenCalledTimes(2)
  })

  it('does nothing while an approval is showing', async () => {
    const user = userEvent.setup()
    const { fake } = renderReply(`\`${ROOT}\\notes.md\``, { suspended: true })
    const button = await screen.findByRole('button')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await user.click(button)
    expect(fake.api.files.openMention).not.toHaveBeenCalled()
  })

  it('shows a refusal at click time and turns back into plain text', async () => {
    const user = userEvent.setup()
    const { fake } = renderReply(`\`${ROOT}\\notes.md\``)
    const button = await screen.findByRole('button')
    // The grant was removed after the text was resolved.
    fake.api.files.openMention.mockResolvedValueOnce({
      ok: false,
      reason: 'That folder is no longer granted.',
    })
    await user.click(button)
    expect(await screen.findByText('That folder is no longer granted.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: `${ROOT}\\notes.md` })).toBeNull()
    expect(document.body.textContent).toContain(`${ROOT}\\notes.md`)
  })

  it('shows the error openPath returned', async () => {
    const user = userEvent.setup()
    const { fake } = renderReply(`\`${ROOT}\\notes.md\``)
    fake.api.files.openMention.mockResolvedValueOnce({
      ok: false,
      reason: 'Windows could not open it: No application is associated with the file.',
    })
    await user.click(await screen.findByRole('button'))
    expect(await screen.findByText(/No application is associated/)).toBeTruthy()
  })

  it('makes a file listing, list items and table cells clickable', async () => {
    renderReply(
      `- notes.md\n- docs/plan.md\n- nothing.md\n\n| file |\n|---|\n| ${ROOT}\\src |\n\n\`\`\`\n${ROOT}\\notes.md\nsrc/\n  indented text\n\`\`\``,
    )
    await waitFor(() => {
      expect(screen.getAllByRole('button')).toHaveLength(6)
    })
    expect(document.body.textContent).toContain('nothing.md')
  })

  it('leaves a code block with a language alone', async () => {
    const { container } = renderReply(
      '```ts\nconst a = "notes.md"\nimport x from "docs/plan.md"\n```',
    )
    await act(() => Promise.resolve())
    expect(container.querySelector('button.path-mention')).toBeNull()
  })

  it('shows a hidden-character name in the clean display, left to right', async () => {
    const text = `${ROOT}\\notes.md`
    const name = `${ROOT}\\no\u202Etes.md`
    const fake = fakeApi({ mentions: { [name]: { ...NOTES, path: name }, [text]: NOTES } })
    render(
      <ApiContext value={fake.api}>
        <ToastProvider>
          <Markdown text={`\`${name}\``} />
        </ToastProvider>
      </ApiContext>,
    )
    const button = await screen.findByRole('button')
    expect(button.textContent).toContain('⟨U+202E⟩')
    expect(document.body.textContent).not.toContain('\u202E')
    expect(button.querySelector('bdi')?.getAttribute('dir')).toBe('ltr')
  })

  it('is not nested in a link or code', async () => {
    renderReply(`[see \`notes.md\`](https://example.com/) and \`\`\`\n\`\`\``)
    await act(() => Promise.resolve())
    expect(document.querySelector('a button')).toBeNull()
  })
})
