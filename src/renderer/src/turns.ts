import type { ViewItem } from './chat-state'

type ToolItem = Extract<ViewItem, { kind: 'tool' }>
type UserItem = Extract<ViewItem, { kind: 'user' }>
type AssistantItem = Extract<ViewItem, { kind: 'assistant' }>

export type Entry =
  | { kind: 'item'; item: AssistantItem }
  | { kind: 'tools'; tools: ToolItem[] }
  /** A command the user typed in the command bar: shown on its own, not as agent work. */
  | { kind: 'command'; item: ToolItem }

/** One prompt and everything the agent did after it, up to the next prompt. */
export interface Turn {
  /** The prompt, or null for work that precedes any prompt. */
  user: UserItem | null
  entries: Entry[]
}

/**
 * Consecutive tool calls become one activity group. A command the user ran stands alone
 * (and splits the group around it); it is not a prompt, so it never starts a turn.
 */
export function groupItems(items: Exclude<ViewItem, UserItem>[]): Entry[] {
  const entries: Entry[] = []
  for (const item of items) {
    if (item.kind === 'tool' && item.origin === 'user-terminal') {
      entries.push({ kind: 'command', item })
      continue
    }
    if (item.kind === 'assistant') {
      entries.push({ kind: 'item', item })
      continue
    }
    const last = entries.at(-1)
    if (last?.kind === 'tools') last.tools.push(item)
    else entries.push({ kind: 'tools', tools: [item] })
  }
  return entries
}

/** Splits the conversation into turns; each user prompt starts one. */
export function splitTurns(items: ViewItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Exclude<ViewItem, UserItem>[] = []
  let user: UserItem | null = null
  const flush = (): void => {
    if (user || current.length > 0) turns.push({ user, entries: groupItems(current) })
  }
  for (const item of items) {
    if (item.kind === 'user') {
      flush()
      user = item
      current = []
    } else {
      current.push(item)
    }
  }
  flush()
  return turns
}

/** "850ms", "1.2s", "12s", "1m 5s", "1h 2m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms)
  if (total < 1000) return `${String(Math.round(total))}ms`
  if (total < 10_000) return `${(Math.floor(total / 100) / 10).toFixed(1)}s`
  const seconds = Math.floor(total / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`
}

/** The scroll-spy rule: the last prompt that starts at or above the viewport's midpoint. */
export function activePromptIndex(tops: readonly number[], midpoint: number): number {
  let active = 0
  for (const [index, top] of tops.entries()) {
    if (top <= midpoint) active = index
    else break
  }
  return active
}

/** The prompt to jump to from `from` (or null at the end of the list). */
export function stepPrompt(from: number, count: number, direction: -1 | 1): number | null {
  const next = from + direction
  return next < 0 || next >= count ? null : next
}

/**
 * The user-perceived characters of `text`: grapheme clusters where Intl.Segmenter is
 * available (an emoji with its modifiers stays whole), code points otherwise (never half
 * a surrogate pair).
 */
function characters(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (!Segmenter) return Array.from(text)
  return Array.from(
    new Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    (part) => part.segment,
  )
}

/**
 * A single line of plain text for a label: whitespace collapsed, control/format characters
 * dropped, and at most `max` characters (see `characters`), the last an ellipsis if cut.
 */
export function plainLabel(text: string, max: number): string {
  const clean = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // A string's UTF-16 length is never less than its character count.
  if (clean.length <= max) return clean
  const chars = characters(clean)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean
}

/** How long a run of tool calls took, from the first call to the last result; null if unknown. */
export function workSpan(tools: readonly ToolItem[]): number | null {
  let start = Infinity
  let end = -Infinity
  for (const tool of tools) {
    if (tool.startedAt === undefined || tool.endedAt === undefined) return null
    start = Math.min(start, tool.startedAt)
    end = Math.max(end, tool.endedAt)
  }
  return end >= start ? end - start : null
}
