import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalPrompt } from '../../../shared/ipc'
import css from '../styles/components.css?raw'
import { ApprovalCard } from './ApprovalCard'
import { SafeText } from './reveal'
import { summarizeInput, ToolCard } from './ToolCard'

const ch = (...codes: number[]): string => String.fromCharCode(...codes)
const HIDDEN = [0x202e, 0x200b, 0x1b, 0x07, 0x0d, 0x85, 0x2028, 0xfeff]

function hiddenIn(text: string): number[] {
  const found: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? -1
    if (HIDDEN.includes(code)) found.push(code)
  }
  return found
}

describe('ToolCard reveals hidden characters', () => {
  it('in the tool name, input summary, full input and result', () => {
    const { container } = render(
      <ToolCard
        running={false}
        item={{
          kind: 'tool',
          id: 't1',
          name: `read${ch(0x202e)}_file`,
          input: { path: `C:\\docs\\invoice${ch(0x202e)}txt.ps1${ch(0x200b)}` },
          result: { content: `${ch(0x1b)}[31mDenied${ch(0x1b)}[0m${ch(7)}\rdone`, isError: true },
        }}
      />,
    )
    const text = container.textContent
    expect(hiddenIn(text)).toEqual([])
    expect(text).toContain('read⟨U+202E⟩_file')
    expect(text).toContain('invoice⟨U+202E⟩txt.ps1⟨U+200B⟩')
    // JSON keeps the bidi character as is, so the full input shows the token too.
    expect(screen.getByLabelText('Tool input').textContent).toContain('⟨U+202E⟩')
    expect(screen.getByLabelText('Tool error').textContent).toBe(
      '⟨ESC[31m⟩Denied⟨ESC[0m⟩⟨U+0007⟩⟨CR⟩\ndone',
    )
  })

  it('marks a command made only of look-alike letters in the collapsed summary', () => {
    const { container } = render(
      <ToolCard
        running={false}
        item={{
          kind: 'tool',
          id: 't2',
          name: 'run_shell',
          input: { command: ch(0x440, 0x430, 0x443) },
          result: null,
        }}
      />,
    )
    const summary = container.querySelector('.tool-input')
    expect(summary?.querySelectorAll('.unsafe-char').length).toBeGreaterThan(0)
    expect(
      screen.getByLabelText('Tool input').querySelectorAll('.unsafe-char').length,
    ).toBeGreaterThan(0)
  })

  it('summarises only the first line of a multi-line command, without collapsing spaces', () => {
    expect(summarizeInput({ command: 'echo  a\tb\nRemove-Item x' })).toBe('echo  a\tb ⏎…')
    expect(summarizeInput({ command: 'one\rtwo' })).toBe('one ⏎…')
  })
})

describe('inline untrusted fields keep distinct whitespace', () => {
  it('preserves spaces and tabs and marks line breaks with ⏎', () => {
    const { container } = render(<SafeText text={'C:\\a  b\tc\nd'} />)
    const bdi = container.querySelector('bdi')
    expect(bdi?.className).toBe('untrusted')
    expect(bdi?.getAttribute('dir')).toBe('ltr')
    expect(bdi?.textContent).toBe('C:\\a  b\tc⏎\nd')
  })

  it('shows two summaries that differ only in whitespace differently', () => {
    const prompt = (summary: string): ApprovalPrompt => ({
      id: summary,
      runId: 'r',
      toolUseId: null,
      tool: 'delete_path',
      kind: 'delete',
      summary,
      detail: null,
    })
    const shown = ['Delete C:\\a b', 'Delete C:\\a  b', 'Delete C:\\a\tb', 'Delete C:\\a\nb'].map(
      (summary) => {
        const view = render(
          <ApprovalCard prompt={prompt(summary)} queued={0} onRespond={vi.fn()} />,
        )
        const text = view.container.querySelector('.approval-summary')?.textContent
        view.unmount()
        return text
      },
    )
    expect(new Set(shown).size).toBe(4)
    expect(shown[3]).toBe('Delete C:\\a⏎\nb')
  })

  it('styles inline untrusted text as pre-wrap so the browser keeps the whitespace', () => {
    expect(css).toMatch(/\.untrusted\s*\{[^}]*white-space:\s*pre-wrap/)
  })
})

describe('ToolCard status: denied comes from main, not from the text', () => {
  const card = (result: { content: string; isError: boolean; declined?: boolean }) => {
    const { container } = render(
      <ToolCard
        running={false}
        item={{ kind: 'tool', id: 't', name: 'write_file', input: { path: 'x' }, result }}
      />,
    )
    return container.querySelector('.tool-status')?.textContent
  }

  it('shows denied when main flags the decline, whatever the text says', () => {
    expect(card({ content: 'Nothing was changed.', isError: true, declined: true })).toBe('denied')
  })

  it('shows failed for an error that only reads like a decline', () => {
    // A tool's output (or a file or command named this way) can start with these words.
    const text = 'The user declined the write to x. Nothing was changed.'
    expect(card({ content: text, isError: true, declined: false })).toBe('failed')
  })

  it("falls back to the tools' wording for a saved result without the flag", () => {
    const text = 'The user declined the write to x. Nothing was changed.'
    expect(card({ content: text, isError: true })).toBe('denied')
    expect(card({ content: 'Access denied: outside granted folders', isError: true })).toBe(
      'failed',
    )
  })
})
