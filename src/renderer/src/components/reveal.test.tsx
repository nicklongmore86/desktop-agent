import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalPrompt } from '../../../shared/ipc'
import { ApprovalCard } from './ApprovalCard'
import { revealUnsafe } from './reveal'

// Built from code points so this file itself holds no invisible characters.
const ch = (...codes: number[]): string => String.fromCharCode(...codes)
const RLO = ch(0x202e)
const ESC = ch(0x1b)

const tokens = (text: string): string[] =>
  revealUnsafe(text).lines.flatMap((line) =>
    line.segments.flatMap((segment) => (segment.kind === 'token' ? [segment.label] : [])),
  )

describe('revealUnsafe', () => {
  it('leaves plain text, tabs and LF lines alone', () => {
    const revealed = revealUnsafe('a\tb\nc')
    expect(revealed.suspicious).toBe(false)
    expect(revealed.lines).toEqual([
      { segments: [{ kind: 'text', text: 'a\tb' }], end: 'lf' },
      { segments: [{ kind: 'text', text: 'c' }], end: 'eof' },
    ])
    // Astral characters (surrogate pairs) are ordinary text.
    expect(revealUnsafe('ok \u{1F600}').suspicious).toBe(false)
  })

  it.each([
    [0x202a],
    [0x202b],
    [0x202c],
    [0x202d],
    [0x202e],
    [0x2066],
    [0x2067],
    [0x2068],
    [0x2069],
    [0x200e],
    [0x200f],
    [0x061c],
  ])('reveals bidi control U+%s', (code) => {
    const label = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
    const revealed = revealUnsafe(`invoice${ch(code)}txt.ps1`)
    expect(revealed.suspicious).toBe(true)
    expect(revealed.lines[0]?.segments).toEqual([
      { kind: 'text', text: 'invoice' },
      { kind: 'token', label },
      { kind: 'text', text: 'txt.ps1' },
    ])
  })

  it.each([[0x200b], [0x200c], [0x200d], [0x2060], [0xfeff]])('reveals zero-width U+%s', (code) => {
    expect(tokens(`rm${ch(code)} -rf`)).toEqual([
      `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
    ])
  })

  it('reveals C0, DEL, C1 and line-separator controls but not tab or LF', () => {
    expect(
      tokens(`a${ch(0)}b${ch(7)}c${ch(8)}d${ch(0x7f)}e${ch(0x85)}f${ch(0x9b)}g${ch(0x2028)}`),
    ).toEqual(['U+0000', 'U+0007', 'U+0008', 'U+007F', 'U+0085', 'U+009B', 'U+2028'])
  })

  it('reveals whole ANSI escape sequences', () => {
    const revealed = revealUnsafe(`${ESC}[31mred${ESC}[0m ${ESC}]0;title${ch(7)}x ${ESC}c`)
    expect(revealed.suspicious).toBe(true)
    expect(revealed.lines[0]?.segments).toEqual([
      { kind: 'token', label: 'ESC[31m' },
      { kind: 'text', text: 'red' },
      { kind: 'token', label: 'ESC[0m' },
      { kind: 'text', text: ' ' },
      { kind: 'token', label: 'ESC]0;title\\x07' },
      { kind: 'text', text: 'x ' },
      { kind: 'token', label: 'ESCc' },
    ])
    // An ESC at a line end never swallows the line break.
    expect(revealUnsafe(`a${ESC}\nb`).lines.map((line) => line.end)).toEqual(['lf', 'eof'])
  })

  it('keeps CRLF and bare CR line boundaries distinct; only a bare CR is suspicious', () => {
    const crlf = revealUnsafe('one\r\ntwo\r\n')
    expect(crlf.suspicious).toBe(false)
    expect(crlf.lines.map((line) => line.end)).toEqual(['crlf', 'crlf'])
    const cr = revealUnsafe('echo safe\rRemove-Item C:\\x')
    expect(cr.suspicious).toBe(true)
    expect(cr.lines).toEqual([
      { segments: [{ kind: 'text', text: 'echo safe' }], end: 'cr' },
      { segments: [{ kind: 'text', text: 'Remove-Item C:\\x' }], end: 'eof' },
    ])
  })
})

const base: ApprovalPrompt = {
  id: 'a1',
  runId: 'r1',
  toolUseId: null,
  tool: 'run_shell',
  kind: 'shell',
  summary: 'Run a command in C:\\work',
  detail: null,
}

function renderCard(prompt: ApprovalPrompt) {
  render(<ApprovalCard prompt={prompt} queued={0} onRespond={vi.fn(() => Promise.resolve())} />)
  return screen.getByRole('alertdialog')
}

describe('ApprovalCard reveals spoofing characters', () => {
  it('shows no warning for clean requests', () => {
    renderCard({ ...base, detail: 'cwd: C:\\work\nshell: C:\\ps.exe -Command\n\nGet-Date' })
    expect(screen.queryByText(/hidden or control characters/)).toBeNull()
  })

  it('reveals a bidi override in the summary and warns', () => {
    const dialog = renderCard({
      ...base,
      kind: 'delete',
      tool: 'delete_path',
      summary: `Move file C:\\docs\\invoice${RLO}txt.ps1 to the Recycle Bin`,
    })
    expect(within(dialog).getByRole('alert').textContent).toContain('hidden or control characters')
    expect(dialog.textContent).toContain('invoice⟨U+202E⟩txt.ps1')
    expect(dialog.textContent).not.toContain(RLO)
  })

  it('reveals tokens in the tool name, shell path, cwd and command', () => {
    const dialog = renderCard({
      ...base,
      tool: `run${ch(0x200b)}_shell`,
      detail: `cwd: C:\\w${ch(0x202e)}ork\nshell: C:\\ps${ch(0x200d)}.exe -Command\n\n${ESC}[8mhidden${ESC}[0m\rRemove-Item -Recurse C:\\`,
    })
    expect(dialog.textContent).toContain('run⟨U+200B⟩_shell')
    expect(screen.getByLabelText('Working folder').textContent).toBe('C:\\w⟨U+202E⟩ork')
    expect(screen.getByLabelText('Shell').textContent).toBe('C:\\ps⟨U+200D⟩.exe -Command')
    const command = screen.getByLabelText('Command')
    expect(command.textContent).toBe('⟨ESC[8m⟩hidden⟨ESC[0m⟩⟨CR⟩\nRemove-Item -Recurse C:\\')
    // Each source line is its own LTR-isolated line.
    const lines = command.querySelectorAll('.untrusted-line')
    expect(lines).toHaveLength(2)
    lines.forEach((line) => {
      expect(line.getAttribute('dir')).toBe('ltr')
    })
    expect(within(dialog).getByRole('alert')).toBeTruthy()
  })

  it('reveals hidden characters inside diff lines and keeps their colouring', () => {
    renderCard({
      ...base,
      tool: 'write_file',
      kind: 'write',
      summary: 'Change C:\\a.txt',
      detail: `@@ -1 +1 @@\n-ok\n+ok${ch(0x200b)}\r\n`,
    })
    const added = screen.getByText((_, element) => element?.textContent === '+ok⟨U+200B⟩⟨CRLF⟩\n')
    expect(added.className).toContain('diff-add')
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('marks CRLF line ends in diffs without warning', () => {
    renderCard({
      ...base,
      tool: 'write_file',
      kind: 'write',
      summary: 'Change C:\\a.txt',
      detail: '@@ -1 +1 @@\r\n-old\r\n+new\r\n',
    })
    expect(screen.getByLabelText('Full diff').textContent).toBe(
      '@@ -1 +1 @@⟨CRLF⟩\n-old⟨CRLF⟩\n+new⟨CRLF⟩\n',
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps very long lines whole: commands wrap, diffs scroll', () => {
    const long = `Write-Output ${'x'.repeat(5000)}; Remove-Item C:\\important`
    renderCard({ ...base, detail: `cwd: C:\\w\nshell: C:\\ps.exe\n\n${long}` })
    const command = screen.getByLabelText('Command')
    expect(command.textContent).toBe(long)
    expect(command.className).toContain('command')
    expect(command.className).toContain('scroll-box')
  })
})
