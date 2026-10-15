/**
 * Display-only defences for untrusted text in approval prompts. Paths,
 * commands and diffs come from the model or from files, so they can carry
 * characters that make what is shown differ from what will run: bidi
 * overrides (`invoice<U+202E>txt.ps1`), zero-width and other invisible format
 * characters, control characters, ANSI escape sequences, bare carriage returns,
 * spaces that are not U+0020, look-alike slashes and dots (`a∕..∕b`), and
 * Cyrillic, Greek or Armenian letters posing as Latin ones (`pаypal`).
 * `revealUnsafe` swaps each one for a visible token; the payload that runs is
 * never changed. Right-to-left letters (Hebrew, Arabic, ...) are not
 * tokenised but flagged (`rtl`): the stylesheet shows untrusted text in stored
 * order, left to right, which is not how those words normally read.
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
  /** True when the text has right-to-left letters; they are shown in stored order. */
  rtl: boolean
}

export interface RevealOptions {
  /**
   * Whether the text is part of something with Latin letters, which makes a
   * word of Latin look-alikes (`рау`) a disguise. Defaults to whether `text`
   * itself has Latin letters; pass the answer for the whole prompt when
   * showing one part of it (a command on its own may have none).
   */
  latinContext?: boolean | undefined
}

const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/
// Every other invisible format character (soft hyphen, tags, invisible operators, ...).
const FORMAT = /\p{Cf}/u
// Variation selectors, the grapheme joiner and the blank Hangul fillers: also invisible.
// (Code points, not a regex class: these combine with whatever precedes them.)
const isInvisible = (code: number): boolean =>
  (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0xe0100 && code <= 0xe01ef) ||
  [0x034f, 0x115f, 0x1160, 0x3164, 0xffa0].includes(code)
// Spaces that look like U+0020 but are not: a shell or a path treats them differently.
const SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/
// Look-alikes of path and command punctuation (/ \\ . :), and every fullwidth ASCII form.
const LOOKALIKE =
  /[\u2215\u2044\u29F8\u29F9\u2216\uFE68\u2024\u2025\u2236\uA789\u0589\u02F8\uFF01-\uFF5E]/
// Scripts with letters that pass for Latin ones.
const LOOKALIKE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}]/u
// Letters of those scripts that look like Latin letters on their own (а е о р с у х ...).
const LATIN_LOOKALIKE =
  /[\u0430\u0435\u043E\u0440\u0441\u0443\u0445\u0455\u0456\u0458\u0501\u051B\u051D\u04BB\u04CF\u04AF\u0410\u0412\u0415\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0425\u0405\u0406\u0408\u04AE\u03BF\u03B1\u03BD\u03B9\u03C1\u03C5\u0391\u0392\u0395\u0396\u0397\u0399\u039A\u039C\u039D\u039F\u03A1\u03A4\u03A5\u03A7\u0585\u057D\u0570]/
const LATIN = /\p{Script=Latin}/u
// Strong right-to-left characters (Bidi_Class R and AL): the Hebrew, Arabic, Syriac,
// Thaana, NKo, Samaritan, Mandaic ... blocks, their presentation forms, and the
// right-to-left ranges of the supplementary planes; not the Arabic letter mark (U+061C),
// a bidi control that is tokenised instead. (JS regexes have no Bidi_Class.)
const RTL =
  /[\u0590-\u061B\u061D-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u

/** True when `text` has Latin letters. */
export const hasLatin = (text: string): boolean => LATIN.test(text)

/** True when `text` has right-to-left letters. */
export const hasRtl = (text: string): boolean => RTL.test(text)
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

/**
 * The offsets of letters posing as Latin ones: Cyrillic, Greek or Armenian
 * letters in a word that also has Latin letters (`pаypal`), and whole words
 * made only of Latin look-alikes (`рау`) when there is Latin context (see
 * RevealOptions). Words in those scripts that cannot pass for Latin are left alone.
 */
export function homoglyphOffsets(text: string, latinContext = hasLatin(text)): Set<number> {
  const offsets = new Set<number>()
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const word = match[0]
    if (!LOOKALIKE_SCRIPT.test(word)) continue
    let disguised = LATIN.test(word)
    if (!disguised && latinContext) {
      disguised = true
      for (const char of word) {
        if (/\p{L}/u.test(char) && !LATIN_LOOKALIKE.test(char)) disguised = false
      }
    }
    if (!disguised) continue
    let offset = match.index
    for (const char of word) {
      if (LOOKALIKE_SCRIPT.test(char)) offsets.add(offset)
      offset += char.length
    }
  }
  return offsets
}

/** Splits `text` into lines and segments, replacing every unsafe character with a token. */
export function revealUnsafe(text: string, options: RevealOptions = {}): Revealed {
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

  const homoglyphs = homoglyphOffsets(text, options.latinContext ?? hasLatin(text))
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
    } else {
      // Keep surrogate pairs together.
      const code = text.codePointAt(i) ?? 0
      const width = code > 0xffff ? 2 : 1
      const point = text.slice(i, i + width)
      if (
        BIDI.test(point) ||
        ZERO_WIDTH.test(point) ||
        CONTROL.test(point) ||
        FORMAT.test(point) ||
        isInvisible(code) ||
        SPACES.test(point) ||
        LOOKALIKE.test(point) ||
        homoglyphs.has(i)
      ) {
        token(hex(point))
      } else {
        plain += point
      }
      i += width
    }
  }
  if (plain || segments.length > 0 || lines.length === 0) endLine('eof')
  return { lines, suspicious, rtl: hasRtl(text) }
}

export const isSuspicious = (text: string | null, options: RevealOptions = {}): boolean =>
  text !== null && revealUnsafe(text, options).suspicious

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
export function SafeText({
  text,
  latinContext,
}: {
  text: string
  latinContext?: boolean | undefined
}): React.JSX.Element {
  const { lines } = revealUnsafe(text, { latinContext })
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
  latinContext,
}: {
  text: string
  lineClass?: (line: RevealedLine) => string
  latinContext?: boolean | undefined
}): React.JSX.Element {
  const { lines } = revealUnsafe(text, { latinContext })
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
