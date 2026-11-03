// search_files' flexible phrase matching: what a person means by "Walk In Freezer" also
// finds "Walk-In Freezer", "WALK-IN", "walkin", "walk  in" and a phrase wrapped (or
// hyphenated) across a PDF's lines. Text and terms are folded alike (NFKC, case, soft
// hyphens and other invisible characters, runs of white space), and a term's words may be
// separated by nothing or by a short run of spaces, dashes, "_" or "/".
//
// The patterns are built here from escaped literal words, never from the model's regex
// syntax, so they run in main: between two words sits only a bounded run of separator
// characters, which no word contains, so each gap has a single way to match and a scan
// costs at most (text length × term length). Terms are capped in number and length.

/** Terms one call may give in anyOf. */
export const MAX_ANY_OF = 10
/** Characters in one anyOf term. */
export const MAX_TERM_LENGTH = 200
/** A term of at most this many letters and digits is matched as a whole word. */
export const SHORT_TERM = 4
/** Lines a match may run on to past the line it starts in (a window of 1 + this). */
export const WINDOW_LINES = 3
/** Separator characters allowed between two words of a term. */
const MAX_GAP = 8
/** Lines folded and scanned at a time. */
const BLOCK = 256
/** A hit's label naming the terms it matched is cut to this many characters. */
const LABEL_CHARS = 60
/** Main is given back to other work at least this often (ms) during one file's scan. */
const YIELD_MS = 20

/** What may separate two words: white space, any dash, "_", "/", or the minus sign. */
const SEP_CLASS = '[\\s\\p{Pd}_/\\u2212]'
const SEP_RUN = new RegExp(`${SEP_CLASS}+`, 'u')
/** Soft hyphens, zero-width spaces and joiners, word joiners and byte order marks. */
const IGNORABLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu
const ASCII = /^\p{ASCII}*$/u
/** Between two lines that must not be matched across (another sheet cell). */
const BARRIER = '\u0000'

export class PhraseError extends Error {}

export interface PhraseOptions {
  /** The phrases to find, in order: a line matching any of them is a hit. */
  terms: readonly string[]
  /** Literal, line-by-line substring matching, as search_files did before. */
  exact: boolean
  caseSensitive: boolean
}

export interface PhraseHit {
  /** The line the match starts in. */
  line: number
  /** Indexes into the terms of every term that matched starting there. */
  terms: number[]
}

type Compiled =
  { kind: 'pattern'; re: RegExp; wholeWord: boolean } | { kind: 'literal'; needle: string }

/** Case folding beyond toLowerCase for what search text commonly holds. */
function foldCase(text: string): string {
  const lower = text.toLowerCase()
  return ASCII.test(lower) ? lower : lower.replace(/\u00DF/gu, 'ss').replace(/\u03C2/gu, '\u03C3')
}

interface FoldedLine {
  text: string
  /** Ends in a hyphen (or soft hyphen) right after a letter: may continue on the next line. */
  hyphen: 'hard' | 'soft' | null
}

/** One line folded for matching: NFKC, case (unless caseSensitive), invisibles, white space. */
export function fold(line: string, caseSensitive: boolean): string {
  let text = ASCII.test(line) ? line : line.normalize('NFKC')
  if (!caseSensitive) text = foldCase(text)
  if (!ASCII.test(text)) text = text.replace(IGNORABLE, '')
  return text.replace(/[\s\0]+/gu, ' ').trim()
}

function foldLine(line: string, caseSensitive: boolean): FoldedLine {
  const text = fold(line, caseSensitive)
  const hyphen = /\p{L}[\p{Pd}\u2212]$/u.test(text)
    ? 'hard'
    : /\p{L}\u00AD\s*$/u.test(line)
      ? 'soft'
      : null
  return { text, hyphen }
}

/**
 * A line folded as `fold` does, with where each folded character came from, a cluster
 * (a character and its combining marks) at a time. Used only to place a snippet.
 */
function foldMapped(line: string, caseSensitive: boolean): { text: string; from: number[] } {
  let text = ''
  const from: number[] = []
  for (const m of line.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    let piece = m[0].normalize('NFKC')
    if (!caseSensitive) piece = foldCase(piece)
    piece = piece.replace(IGNORABLE, '')
    if (!piece) continue
    if (/^[\s\0]+$/u.test(piece)) {
      if (text === '' || text.endsWith(' ')) continue
      piece = ' '
    }
    text += piece
    for (let i = 0; i < piece.length; i++) from.push(m.index)
  }
  return { text, from }
}

const escape = (word: string): string => word.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')

/** One term as a pattern over folded text, or as a literal when it has no words. */
function compileTerm(term: string, options: PhraseOptions): Compiled {
  if (term === '') throw new PhraseError('a search term is empty.')
  if (options.exact) {
    return { kind: 'literal', needle: options.caseSensitive ? term : term.toLowerCase() }
  }
  const folded = fold(term, options.caseSensitive)
  const words = folded.split(SEP_RUN).filter(Boolean)
  if (words.length === 0) {
    // Only separators ("-", "/"): looked for as typed, a line at a time.
    if (!term.trim()) throw new PhraseError('a search term is empty.')
    return { kind: 'literal', needle: options.caseSensitive ? term : term.toLowerCase() }
  }
  const compact = words.join('').replace(/[^\p{L}\p{N}]/gu, '')
  const code = /\p{L}/u.test(compact) && /\p{N}/u.test(compact)
  const wholeWord = compact.length > 0 && (compact.length <= SHORT_TERM || code)
  const body = words.map(escape).join(`${SEP_CLASS}{0,${String(MAX_GAP)}}`)
  const source = wholeWord ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body
  return { kind: 'pattern', re: new RegExp(source, 'gu'), wholeWord }
}

/** The first index in `starts` (sorted) at or before `offset`. */
function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** A line cut to `max` characters around [at, at + length), with an ellipsis where cut. */
export function windowAround(text: string, at: number, length: number, max: number): string {
  if (text.length <= max) return text
  if (at + length < max) return `${text.slice(0, Math.max(0, max - 1))}…`
  const width = Math.max(1, max - 2)
  const start = Math.max(
    1,
    Math.min(at - Math.floor(Math.max(0, width - length) / 2), text.length - width),
  )
  const end = start + width
  return `…${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

const nextTick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

export interface MatchControl {
  /** Whether line `i` continues line `i - 1` (same page, not a sheet cell); default all do. */
  joinable?: ((index: number) => boolean) | undefined
  /** Milliseconds left in the search; matching stops at 0. */
  timeLeft: () => number
  signal: AbortSignal
}

/** Compiled phrase terms, matched over a file's or a page's lines. */
export class PhraseMatcher {
  readonly terms: readonly string[]
  private readonly compiled: Compiled[]
  private readonly caseSensitive: boolean

  constructor(options: PhraseOptions) {
    if (options.terms.length === 0) throw new PhraseError('no search terms.')
    this.terms = options.terms
    this.caseSensitive = options.caseSensitive
    this.compiled = options.terms.map((term) => compileTerm(term, options))
  }

  /** Whether term `index` is matched as a whole word (short terms and codes like A-501). */
  wholeWord(index: number): boolean {
    const c = this.compiled[index]
    return c?.kind === 'pattern' && c.wholeWord
  }

  /**
   * The lines where a term's match starts, first `room` of them in line order, with the
   * terms found there; 'time' or 'cancelled' when the search must stop. Pattern terms
   * may run on into the next WINDOW_LINES joinable lines; literal ones stay in a line.
   */
  async match(
    lines: readonly string[],
    room: number,
    control: MatchControl,
  ): Promise<PhraseHit[] | 'time' | 'cancelled'> {
    const hits: PhraseHit[] = []
    const joinable = control.joinable ?? ((): boolean => true)
    let yielded = Date.now()
    for (let from = 0; from < lines.length && hits.length < room; from += BLOCK) {
      // A long scan gives main back now and then, and stops for a cancel or the deadline;
      // a short one (most files) runs through, as a substring search does.
      if (Date.now() - yielded >= YIELD_MS) {
        await nextTick()
        yielded = Date.now()
        if (control.signal.aborted) return 'cancelled'
        if (control.timeLeft() <= 0) return 'time'
      }
      const to = Math.min(lines.length, from + BLOCK)
      const found = new Map<number, Set<number>>()
      const add = (line: number, term: number): void => {
        const set = found.get(line) ?? new Set<number>()
        set.add(term)
        found.set(line, set)
      }
      if (this.compiled.some((c) => c.kind === 'pattern')) {
        // The block's lines folded and joined, plus a few lines after it a match may run
        // on into; a match counts here only if it starts inside the block.
        let text = ''
        const starts: number[] = []
        let previous: FoldedLine | null = null
        let blockEnd = -1
        for (let i = from; i < Math.min(lines.length, to + WINDOW_LINES); i++) {
          if (i >= to && !joinable(i)) break
          const line = foldLine(lines[i] ?? '', this.caseSensitive)
          if (i > from) {
            if (!joinable(i)) {
              text += BARRIER
            } else if (previous?.hyphen && /^\p{L}/u.test(line.text)) {
              // A word broken across the lines: rejoined, its hyphen dropped.
              if (previous.hyphen === 'hard') text = text.slice(0, -1)
            } else {
              text += '\n'
            }
          }
          if (i === to) blockEnd = text.length
          starts.push(text.length)
          text += line.text
          previous = line
        }
        if (blockEnd < 0) blockEnd = text.length
        for (const [t, c] of this.compiled.entries()) {
          if (c.kind !== 'pattern') continue
          c.re.lastIndex = 0
          for (let m = c.re.exec(text); m !== null; m = c.re.exec(text)) {
            if (m.index >= blockEnd) break
            const line = lineAt(starts, m.index)
            if (lineAt(starts, m.index + m[0].length - 1) - line > WINDOW_LINES) {
              // Runs on too far: look for a shorter match starting further on.
              c.re.lastIndex = m.index + 1
              continue
            }
            add(from + line, t)
            // Only the first match per line matters: skip to the next line.
            const next = starts[line + 1]
            if (next === undefined || next >= blockEnd) break
            c.re.lastIndex = Math.max(c.re.lastIndex, next)
          }
        }
      }
      for (const [t, c] of this.compiled.entries()) {
        if (c.kind !== 'literal') continue
        for (let i = from; i < to; i++) {
          const line = lines[i] ?? ''
          if ((this.caseSensitive ? line : line.toLowerCase()).includes(c.needle)) add(i, t)
        }
      }
      for (const line of [...found.keys()].sort((a, b) => a - b)) {
        if (hits.length >= room) break
        hits.push({ line, terms: [...(found.get(line) ?? [])].sort((a, b) => a - b) })
      }
    }
    return hits
  }

  /**
   * A matched line cut to `max` characters around the first of `terms` found in it; a
   * match that starts at the end of the line and runs on to the next shows the line's end.
   */
  snippet(text: string, max: number, terms: readonly number[]): string {
    if (text.length <= max) return text
    for (const t of terms) {
      const c = this.compiled[t]
      if (!c) continue
      if (c.kind === 'literal') {
        const at = (this.caseSensitive ? text : text.toLowerCase()).indexOf(c.needle)
        if (at >= 0) return windowAround(text, at, c.needle.length, max)
        continue
      }
      const mapped = foldMapped(text, this.caseSensitive)
      const re = new RegExp(c.re.source, 'u')
      const m = re.exec(mapped.text)
      if (m) {
        const at = mapped.from[m.index] ?? 0
        const last = mapped.from[m.index + m[0].length - 1] ?? at
        return windowAround(text, at, last - at + 1, max)
      }
    }
    return windowAround(text, text.length - 1, 1, max)
  }

  /**
   * '(matched "WIC") ' naming the terms found, when there is more than one term, at most
   * LABEL_CHARS long; else ''.
   */
  label(terms: readonly number[], clean: (text: string) => string): string {
    if (this.terms.length < 2 || terms.length === 0) return ''
    const names = terms.map((t) => `"${cut(clean(this.terms[t] ?? ''), 40)}"`).join(', ')
    return `(matched ${cut(names, LABEL_CHARS - 10)}) `
  }
}

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
