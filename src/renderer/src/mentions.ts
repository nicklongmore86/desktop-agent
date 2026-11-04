// Files and folders a reply names. The renderer only PROPOSES text that may be one; main
// decides (files/mention.ts) and a proposal that is not inside a granted folder stays plain
// text. Detection here is deliberately conservative, since every proposal costs a question to
// main: it takes whole inline code, whole link targets, whole list items, table cells and
// listing lines, quoted paths, and words that are unmistakably paths (a drive letter, or a
// separator plus a file extension or a closing slash). It misses a path with spaces written in
// plain prose, a folder named only by its name, and tree drawings; see docs/reply-links.md.
import type { MentionOpenResult, MentionResolution } from '../../shared/ipc-files'
import { MENTION_MAX_BATCH, MENTION_MAX_TEXT } from '../../shared/ipc-files'
import type { DesktopApi } from '../../shared/ipc'

// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/
const HAS_SEPARATOR = /[\\/]/
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}(?::\d{1,6}){0,2}$/
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:(?!\d)/ // `https:`, `file:`, `mailto:`; not `a.txt:42`
// Characters no file name can hold on Windows, or that end a path in prose.
const NOT_IN_PATH = /[<>"|?*]/

/** True when the text could name a file or folder: a proposal for main, nothing more. */
export function couldBePath(text: string, wholeText: boolean): boolean {
  if (text.length < 2 || text.length > MENTION_MAX_TEXT) return false
  if (CONTROL.test(text) || NOT_IN_PATH.test(text)) return false
  if (WINDOWS_ABSOLUTE.test(text)) return true
  if (text.startsWith('/') || text.startsWith('\\') || text.startsWith('~')) return false
  if (SCHEME.test(text) || text.includes('://')) return false
  if (text.startsWith('www.')) return false
  // Prose: only what cannot be anything else. A whole inline code, link or list line may be a
  // bare file name (`notes.md`).
  if (wholeText) return HAS_SEPARATOR.test(text) || HAS_EXTENSION.test(text)
  const tail = text.replace(/[\\/]+$/, '')
  return HAS_SEPARATOR.test(text) && (HAS_EXTENSION.test(tail) || /[\\/]$/.test(text))
}

export interface TextPart {
  /** What is shown for this part. */
  text: string
  /** The text to propose to main when this part may be a file or folder. */
  mention?: string
  /** Shown instead when main says `mention` is not one (the same text, split into words). */
  alt?: TextPart[]
}

/** Trailing sentence punctuation that is not part of a path in prose. */
const TRAILING = /[.,;:!?)\]}>'"’”]+$/
const LEADING = /^[([{<'"‘“]+/

/**
 * Splits a piece of reply text into plain text and proposals. `whole` is true when the text is
 * a whole list item, table cell or paragraph: then the whole line is proposed (a path with
 * spaces is fine there), and if main says it is not a path the words in it are tried one by one.
 */
export function splitMentions(text: string, whole: boolean): TextPart[] {
  const line = text.trim()
  if (whole && line !== '') {
    const spaced = /\s/.test(line)
    const plausible = spaced
      ? line.length <= 300 &&
        (WINDOWS_ABSOLUTE.test(line) || (HAS_SEPARATOR.test(line) && HAS_EXTENSION.test(line)))
      : couldBePath(line, true)
    if (plausible && couldBePath(line, true)) {
      const start = text.indexOf(line)
      const parts: TextPart[] = []
      if (start > 0) parts.push({ text: text.slice(0, start) })
      parts.push({ text: line, mention: line, alt: spaced ? splitWords(line) : [{ text: line }] })
      if (start + line.length < text.length) parts.push({ text: text.slice(start + line.length) })
      return parts
    }
  }
  return splitWords(text)
}

function splitWords(text: string): TextPart[] {
  const parts: TextPart[] = []
  let cursor = 0
  const push = (value: string, mention?: string): void => {
    if (value === '') return
    const last = parts.at(-1)
    if (mention === undefined && last && last.mention === undefined) last.text += value
    else parts.push(mention === undefined ? { text: value } : { text: value, mention })
  }
  for (const match of text.matchAll(/"([^"\n]{2,300})"|'([^'\n]{2,300})'|\S+/g)) {
    const quoted = match[1] ?? match[2]
    const start = match.index
    let word = match[0]
    let from = start
    if (quoted !== undefined) {
      const inner = quoted
      if (couldBePath(inner, true) && (WINDOWS_ABSOLUTE.test(inner) || HAS_SEPARATOR.test(inner))) {
        push(text.slice(cursor, start + 1))
        push(inner, inner)
        cursor = start + 1 + inner.length
        continue
      }
      // Not a path: look at the words inside the quotes like any other word.
      continue
    }
    const lead = LEADING.exec(word)?.[0] ?? ''
    word = word.slice(lead.length)
    from += lead.length
    const trail = TRAILING.exec(word)?.[0] ?? ''
    // A closing slash or a line number is part of the path; sentence punctuation is not.
    const core = trail === '' ? word : word.slice(0, -trail.length)
    if (core !== '' && couldBePath(core, false)) {
      push(text.slice(cursor, from))
      push(core, core)
      cursor = from + core.length
    }
  }
  push(text.slice(cursor))
  return parts.length > 0 ? parts : [{ text }]
}

// ---- Asking main --------------------------------------------------------------------------

const TTL_MS = 5000
type Pending = {
  api: DesktopApi
  texts: string[]
  resolvers: Map<string, ((r: MentionResolution) => void)[]>
}
const cache = new Map<string, { at: number; answer: Promise<MentionResolution> }>()
let queue: Pending | null = null

function flushQueue(): void {
  const batch = queue
  queue = null
  if (!batch) return
  const asked = batch.texts
  const answers = batch.api.files.resolveMentions(asked)
  void answers.then(
    (list) => {
      asked.forEach((text, i) => {
        const answer = list[i] ?? { ok: false as const }
        for (const done of batch.resolvers.get(text) ?? []) done(answer)
      })
    },
    () => {
      for (const text of asked)
        for (const done of batch.resolvers.get(text) ?? []) done({ ok: false })
    },
  )
}

/**
 * What main says a click on this text would do, batched with its neighbours into one call and
 * remembered for a few seconds. Main decides again on the click itself, so a stale answer can
 * only show a wrong hint, never open anything.
 */
export function resolveMention(api: DesktopApi, text: string): Promise<MentionResolution> {
  const now = Date.now()
  const hit = cache.get(text)
  if (hit && now - hit.at < TTL_MS) return hit.answer
  const answer = new Promise<MentionResolution>((resolve) => {
    if (queue === null || queue.texts.length >= MENTION_MAX_BATCH) {
      if (queue !== null) flushQueue()
      queue = { api, texts: [], resolvers: new Map() }
      queueMicrotask(flushQueue)
    }
    queue.texts.push(text)
    queue.resolvers.set(text, [...(queue.resolvers.get(text) ?? []), resolve])
  })
  cache.set(text, { at: now, answer })
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return answer
}

/** Forgets every remembered answer (a click found the grants had changed). */
export function forgetMentions(): void {
  cache.clear()
}

export function openMention(api: DesktopApi, text: string): Promise<MentionOpenResult> {
  forgetMentions()
  return api.files.openMention(text)
}
