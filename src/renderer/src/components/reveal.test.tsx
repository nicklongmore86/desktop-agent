import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalPrompt } from '../../../shared/ipc'
import { ApprovalCard } from './ApprovalCard'
import { revealUnsafe } from './reveal'

// Built from code points so this file itself holds no invisible characters.
const ch = (...codes: number[]): string => String.fromCharCode(...codes)
const RLO = ch(0x202e)
const ESC = ch(0x1b)

/** The code points of `text` that are in `codes`. */
function prohibitedIn(text: string, codes: number[]): number[] {
  const found: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? -1
    if (codes.includes(code)) found.push(code)
  }
  return found
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

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
      { kind: 'token', label: 'ESC]0;title{U+0007}' },
      { kind: 'text', text: 'x ' },
      { kind: 'token', label: 'ESCc' },
    ])
    // An ESC at a line end never swallows the line break.
    expect(revealUnsafe(`a${ESC}\nb`).lines.map((line) => line.end)).toEqual(['lf', 'eof'])
  })

  describe('never lets a prohibited code point through, even inside escape sequences', () => {
    const PROHIBITED_CODES = [
      ...range(0x00, 0x08),
      0x0b,
      0x0c,
      0x0d,
      ...range(0x0e, 0x1f),
      ...range(0x7f, 0x9f),
      ...range(0x202a, 0x202e),
      ...range(0x2066, 0x2069),
      0x200e,
      0x200f,
      0x061c,
      ...range(0x200b, 0x200d),
      0x2060,
      0xfeff,
      0x2028,
      0x2029,
    ]
    const BEL = ch(7)
    const contexts: [string, (p: string) => string][] = [
      ['plain text', (p) => `a${p}b`],
      ['an OSC title', (p) => `${ESC}]0;invoice${p}txt.ps1${BEL}`],
      ['an unterminated OSC', (p) => `${ESC}]0;x${p}y`],
      ['an OSC ended by ST', (p) => `${ESC}]8;;${p}${ESC}\\link`],
      ['a generic ESC', (p) => `${ESC}${p}rest`],
      ['a CSI', (p) => `${ESC}[3${p}1m`],
      ['nested escapes', (p) => `${ESC}]0;${ESC}${p}${BEL}`],
    ]
    const cases = contexts.flatMap(([name, wrap]) =>
      PROHIBITED_CODES.map((code) => [name, code, wrap(ch(code))] as const),
    )

    it.each(contexts.map(([name]) => [name]))('in %s', (name) => {
      for (const [caseName, code, input] of cases) {
        if (caseName !== name) continue
        const revealed = revealUnsafe(input)
        expect(revealed.suspicious).toBe(true)
        for (const line of revealed.lines) {
          for (const segment of line.segments) {
            const shown = segment.kind === 'text' ? segment.text : segment.label
            const bad = prohibitedIn(shown, PROHIBITED_CODES)
            expect(bad, `${name} with U+${code.toString(16)}`).toEqual([])
          }
        }
      }
    })

    it('in the rendered approval card', () => {
      const detail = `cwd: C:\\w\nshell: C:\\ps.exe\n\n${cases.map(([, , input]) => input).join(' ')}`
      const dialog = renderCard({ ...base, summary: cases[0]?.[2] ?? '', detail })
      // LF is the only control left: the real line breaks between revealed lines.
      expect(prohibitedIn(dialog.textContent, PROHIBITED_CODES)).toEqual([])
    })
  })

  it('never lets an escape sequence swallow CR or LF line boundaries', () => {
    const lf = revealUnsafe(`${ESC}]0;title\nRemove-Item C:\\${ch(7)}`)
    expect(lf.lines.map((line) => line.end)).toEqual(['lf', 'eof'])
    expect(lf.lines[0]?.segments).toEqual([{ kind: 'token', label: 'ESC]0;title' }])
    expect(lf.lines[1]?.segments).toEqual([
      { kind: 'text', text: 'Remove-Item C:\\' },
      { kind: 'token', label: 'U+0007' },
    ])
    const cr = revealUnsafe(`${ESC}]0;a\rb`)
    expect(cr.lines.map((line) => line.end)).toEqual(['cr', 'eof'])
    expect(revealUnsafe(`${ESC}\r\nx`).lines.map((line) => line.end)).toEqual(['crlf', 'eof'])
  })

  it('bounds escape sequences so they cannot hide long stretches of text', () => {
    const hidden = 'y'.repeat(400)
    const revealed = revealUnsafe(`${ESC}]0;${hidden}`)
    const [first, ...rest] = revealed.lines[0]?.segments ?? []
    expect(first?.kind).toBe('token')
    expect(first?.kind === 'token' && first.label.length).toBeLessThanOrEqual(260)
    // Everything past the bound is shown as ordinary text, nothing is dropped.
    const shown = [first, ...rest]
      .map((segment) => (segment?.kind === 'text' ? segment.text : (segment?.label ?? '')))
      .join('')
    expect(shown).toBe(`ESC]0;${hidden}`)
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
