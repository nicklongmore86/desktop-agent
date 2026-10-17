import type { ViewItem } from '../chat-state'
import { formatDuration } from '../turns'
import { useNow } from '../use-now'
import { hasLatin, SafeLines, SafeText } from './reveal'
import { StatusIcon, type ToolStatus } from './StatusIcon'

const MAX_SUMMARY = 80
/** Tool output can be large; the card shows the start of it. */
const MAX_RESULT_CHARS = 20_000

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A one-line description of a tool call's input: its path(s), command or pattern. */
export function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const str = (key: string): string | undefined =>
    typeof fields[key] === 'string' ? fields[key] : undefined
  const source = str('source')
  const destination = str('destination')
  const summary =
    str('command') ??
    (source && destination ? `${source} → ${destination}` : undefined) ??
    [str('path'), str('namePattern'), str('contentPattern')].filter(Boolean).join(' ')
  // One line only: the full, revealed input is in the card body.
  const [first = '', ...more] = summary.trim().split(/\r\n|\r|\n/)
  return truncate(more.length > 0 ? `${first} ⏎…` : first, MAX_SUMMARY)
}

function stringify(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

type ToolItem = Extract<ViewItem, { kind: 'tool' }>

/**
 * What the tools say when the user declines their approval (see main/tools). Only for
 * results without main's `declined` flag: chats saved before it was recorded, and agent
 * tool results reloaded from history (the Messages API has nowhere to keep it).
 */
const LEGACY_DECLINED = /^The user declined /

/** Whether the user declined the call: main's flag, or the legacy wording when there is none. */
function wasDeclined(result: NonNullable<ToolItem['result']>): boolean {
  return result.declined ?? LEGACY_DECLINED.test(result.content)
}

/** `queued`: the call is waiting for the user's approval. */
export function toolStatus(item: ToolItem, running: boolean, queued = false): ToolStatus {
  if (item.result) {
    if (!item.result.isError) return 'done'
    return wasDeclined(item.result) ? 'denied' : 'error'
  }
  if (!running) return 'no result'
  return queued ? 'queued' : 'running'
}

export const STATUS_TEXT: Record<ToolStatus, string> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  error: 'failed',
  denied: 'denied',
  'no result': 'no result',
}

/** How long a call took: counts up while it is under way, then stays at its final value. */
export function Elapsed({
  item,
  status,
}: {
  item: ToolItem
  status: ToolStatus
}): React.JSX.Element | null {
  const live = status === 'running' || status === 'queued'
  const now = useNow(live)
  if (item.startedAt === undefined) return null
  const end = item.endedAt ?? (live ? now : undefined)
  if (end === undefined) return null
  return <span className="tool-elapsed">{formatDuration(end - item.startedAt)}</span>
}

/** A collapsible card for one tool call: name, input summary, status, and full input/result. */
export function ToolCard({
  item,
  running,
  queued = false,
}: {
  item: ToolItem
  running: boolean
  /** Waiting for the user's approval. */
  queued?: boolean
}): React.JSX.Element {
  const status = toolStatus(item, running, queued)
  const content = item.result?.content ?? ''
  // The expanded input is JSON, whose Latin keys make a look-alike word a disguise; give the
  // one-line summary the same context so a command made only of look-alikes is marked too.
  const latinContext = hasLatin(stringify(item.input)) || hasLatin(item.name)
  return (
    <details className={`tool-card tool-${status.replace(' ', '-')}`}>
      <summary>
        <StatusIcon status={status} />
        <span className="tool-name">
          <SafeText text={item.name} latinContext={latinContext} />
        </span>
        <span className="tool-input">
          <SafeText text={summarizeInput(item.input)} latinContext={latinContext} />
        </span>
        <span className="tool-status">{STATUS_TEXT[status]}</span>
        <Elapsed item={item} status={status} />
      </summary>
      <div className="tool-body">
        <h4>Input</h4>
        <pre className="scroll-box untrusted-block" dir="ltr" aria-label="Tool input">
          <SafeLines text={stringify(item.input)} />
        </pre>
        {item.result && (
          <>
            <h4>{item.result.isError ? 'Error' : 'Result'}</h4>
            <pre
              className={`scroll-box untrusted-block${item.result.isError ? ' tool-error-text' : ''}`}
              dir="ltr"
              aria-label={item.result.isError ? 'Tool error' : 'Tool result'}
            >
              <SafeLines text={truncate(content, MAX_RESULT_CHARS)} />
            </pre>
          </>
        )}
      </div>
    </details>
  )
}
