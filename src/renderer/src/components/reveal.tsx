/**
 * Display-only defences for untrusted text in approval prompts. Paths,
 * commands and diffs come from the model or from files, so they can carry
 * characters that make what is shown differ from what will run: bidi
 * overrides (`invoice<U+202E>txt.ps1`), zero-width characters, control characters,
 * ANSI escape sequences and bare carriage returns. `revealUnsafe` swaps each
 * one for a visible token; the payload that runs is never changed.
 */

export type Segment =
  | { kind: 'text'; text: string }
  /** A hidden or control character, shown as a visible token. */
  | { kind: 'token'; label: string }

export interface RevealedLine {
  segments: Segment[]
  /** How the line ended: LF, CRLF, a bare CR (a line break for PowerShell), or end of text. */
  end: 'lf' | 'crlf' | 'cr' | 'eof'
}

export interface Revealed {
  lines: RevealedLine[]
  /** True when anything but plain text, tabs and LF/CRLF line ends was found. */
  suspicious: boolean
}

const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/
// C0 except \t (09) and \n (0A); CR (0D) is handled as a line end; DEL; C1;
// and the Unicode line/paragraph separators, which some renderers break on.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/
// ESC sequences: CSI (ESC [ params final), OSC (ESC ] text, ended by BEL or ESC \), or ESC + one
// char. Bounded, and never across CR or LF, so a sequence cannot swallow a line break or hide a
// long stretch of text; whatever is left over is scanned as ordinary text.
const ESCAPE =
  // eslint-disable-next-line no-control-regex
  /^\u001B(?:\[[0-?]{0,32}[ -/]{0,8}[@-~]|\][^\u0007\u001B\r\n]{0,256}(?:\u0007|\u001B\\)?|[^\r\n]?)/

const hex = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`

/**
 * A token label for an escape sequence's body. Only printable ASCII is kept
 * as is; every other character (controls, bidi, zero-width, C1, separators,
 * and any non-ASCII) becomes `{U+XXXX}`, so a label can never carry a
 * prohibited character itself.
 */
export function escapeLabel(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += code >= 0x20 && code <= 0x7e ? char : `{${hex(char)}}`
  }
  return out
}

/** Splits `text` into lines and segments, replacing every unsafe character with a token. */
export function revealUnsafe(text: string): Revealed {
  const lines: RevealedLine[] = []
  let segments: Segment[] = []
  let plain = ''
  let suspicious = false
  const flush = (): void => {
    if (plain) segments.push({ kind: 'text', text: plain })
    plain = ''
  }
  const token = (label: string): void => {
    flush()
    segments.push({ kind: 'token', label })
    suspicious = true
  }
  const endLine = (end: RevealedLine['end']): void => {
    flush()
    lines.push({ segments, end })
    segments = []
  }

  for (let i = 0; i < text.length;) {
    const char = text[i] ?? ''
    if (char === '\n') {
      endLine('lf')
      i += 1
    } else if (char === '\r') {
      if (text[i + 1] === '\n') {
        endLine('crlf')
        i += 2
      } else {
        // A bare CR is a line break for PowerShell and a carriage return in terminals.
        suspicious = true
        endLine('cr')
        i += 1
      }
    } else if (char === '\u001B') {
      const sequence = ESCAPE.exec(text.slice(i))?.[0] ?? char
      token(`ESC${escapeLabel(sequence.slice(1))}`)
      i += sequence.length
    } else if (BIDI.test(char) || ZERO_WIDTH.test(char) || CONTROL.test(char)) {
      token(hex(char))
      i += 1
    } else {
      // Keep surrogate pairs together.
      const code = text.codePointAt(i) ?? 0
      const width = code > 0xffff ? 2 : 1
      plain += text.slice(i, i + width)
      i += width
    }
  }
  if (plain || segments.length > 0 || lines.length === 0) endLine('eof')
  return { lines, suspicious }
}

export const isSuspicious = (text: string | null): boolean =>
  text !== null && revealUnsafe(text).suspicious

function Segments({ segments }: { segments: Segment[] }): React.JSX.Element {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          segment.text
        ) : (
          <span
            // Segments are positional, so the index is the stable key.
            key={index}
            className="unsafe-char"
            title="Hidden or control character"
          >
            ⟨{segment.label}⟩
          </span>
        ),
      )}
    </>
  )
}

const END_MARKS: Record<RevealedLine['end'], string | null> = {
  lf: null,
  eof: null,
  crlf: '⟨CRLF⟩',
  cr: '⟨CR⟩',
}

/**
 * One revealed line, isolated left-to-right, with a visible mark for CR and
 * CRLF line ends. Inline fields (paths, summaries) also mark LF with ⏎, since
 * a line break there is never expected and must not pass for a space.
 */
function Line({
  line,
  className,
  inline = false,
}: {
  line: RevealedLine
  className?: string | undefined
  inline?: boolean
}): React.JSX.Element {
  const mark = inline && line.end === 'lf' ? '⏎' : END_MARKS[line.end]
  return (
    <span className={`untrusted-line${className ? ` ${className}` : ''}`} dir="ltr">
      <Segments segments={line.segments} />
      {mark && (
        <span className={line.end === 'cr' ? 'unsafe-char' : 'line-end-mark'} title="Line ending">
          {mark}
        </span>
      )}
      {line.end === 'eof' ? '' : '\n'}
    </span>
  )
}

/**
 * Untrusted inline text (tool name, summary, path): isolated LTR, unsafe
 * characters revealed, and whitespace preserved (`.untrusted` is pre-wrap),
 * so two spaces, a tab and a line break never collapse into one space.
 */
export function SafeText({ text }: { text: string }): React.JSX.Element {
  const { lines } = revealUnsafe(text)
  return (
    <bdi dir="ltr" className="untrusted">
      {lines.map((line, index) => (
        <Line key={index} line={line} inline />
      ))}
    </bdi>
  )
}

/** Untrusted multi-line text, one isolated line per source line; `lineClass` styles each line. */
export function SafeLines({
  text,
  lineClass,
}: {
  text: string
  lineClass?: (line: RevealedLine) => string
}): React.JSX.Element {
  const { lines } = revealUnsafe(text)
  if (lines.length > 1 && lines.at(-1)?.end === 'eof' && lines.at(-1)?.segments.length === 0) {
    lines.pop()
  }
  return (
    <>
      {lines.map((line, index) => (
        <Line key={index} line={line} className={lineClass?.(line)} />
      ))}
    </>
  )
}

/** The line's leading plain text ('' if it starts with a token), e.g. for a diff's +/- prefix. */
export const leadingText = (line: RevealedLine): string => {
  const first = line.segments[0]
  return first?.kind === 'text' ? first.text : ''
}
