import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
import { ToastProvider } from './Toast'

/** user-event installs its own clipboard on setup(), so stub ours after it. */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('Markdown safety', () => {
  it('drops raw HTML and script tags, keeping the text', () => {
    const { container } = render(
      <Markdown
        text={'Hello <script>alert(1)</script> <b onclick="x()">bold</b> <img src=x onerror=y>'}
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).not.toContain('onclick')
    expect(container.innerHTML).not.toContain('onerror')
  })

  it('does not render HTML inside code fences as elements', () => {
    const { container } = render(<Markdown text={'```html\n<script>alert(1)</script>\n```'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toContain('<script>alert(1)</script>')
  })

  it('strips javascript: and other unsafe link targets', () => {
    render(
      <Markdown
        text={
          '[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html,x) [ok](https://example.com)'
        }
      />,
    )
    for (const name of ['a', 'b', 'c']) {
      expect(screen.getByText(name).closest('a')?.getAttribute('href') ?? '').toBe('')
    }
    expect(screen.getByText('ok').closest('a')?.getAttribute('href')).toBe('https://example.com')
    expect(screen.getByText('ok').closest('a')?.getAttribute('rel')).toBe('noreferrer noopener')
  })

  it('never loads images, even from GFM autolinks and reference syntax', () => {
    const { container } = render(
      <Markdown
        text={'![logo](https://example.com/x.png)\n\n![ref][r]\n\n[r]: https://example.com/y.png'}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('[image: logo]')
    expect(container.textContent).toContain('[image: ref]')
  })
})

describe('Markdown formatting', () => {
  it('renders GFM tables inside a scrollable wrapper', () => {
    const { container } = render(<Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |'} />)
    expect(screen.getByRole('columnheader', { name: 'a' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '2' })).toBeTruthy()
    expect(container.querySelector('.md-table > table')).not.toBeNull()
  })

  it('renders task lists as disabled checkboxes and strikethrough', () => {
    const { container } = render(<Markdown text={'- [x] done\n- [ ] todo\n\n~~old~~'} />)
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false])
    for (const box of boxes) expect((box as HTMLInputElement).disabled).toBe(true)
    expect(container.querySelector('del')?.textContent).toBe('old')
  })

  it('highlights known languages and leaves unknown ones plain', () => {
    const { container } = render(
      <Markdown
        text={
          '```ts\nconst x: number = 1\n```\n\n```nonsense\nconst y = 2\n```\n\n```ps1\nGet-ChildItem\n```'
        }
      />,
    )
    expect(container.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0)
    const blocks = container.querySelectorAll('.code-block')
    expect(blocks).toHaveLength(3)
    expect(blocks[1]?.querySelector('[class*="hljs-"]')).toBeNull()
    expect(blocks[1]?.querySelector('.code-block-language')?.textContent).toBe('nonsense')
    expect(
      blocks[2]?.querySelector('.hljs-built_in, .hljs-title, .hljs-keyword, [class*="hljs-"]'),
    ).not.toBeNull()
  })

  it('labels a block with no language as text', () => {
    render(<Markdown text={'```\nplain\n```'} />)
    expect(screen.getByText('text')).toBeTruthy()
  })
})

describe('CodeBlock copy', () => {
  it('copies the raw source text, not highlighted HTML, and announces it', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    const user = userEvent.setup()
    stubClipboard(writeText)
    render(
      <ToastProvider>
        <Markdown text={'```ts\nconst a = "x" // <b>\nlet b = 1\n```'} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledWith('const a = "x" // <b>\nlet b = 1')
    expect(screen.getByRole('status').textContent).toBe('Copied')
  })

  it('says so when the clipboard refuses', async () => {
    const user = userEvent.setup()
    stubClipboard(() => Promise.reject(new Error('denied')))
    render(
      <ToastProvider>
        <Markdown text={'```\nx\n```'} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(await screen.findByText('Could not copy')).toBeTruthy()
  })
})
