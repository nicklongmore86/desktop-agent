import type { ChatItem } from '../../../shared/ipc'
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

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

export function toolStatus(item: ToolItem, running: boolean): ToolStatus {
  if (item.result) return item.result.isError ? 'error' : 'done'
  return running ? 'running' : 'no result'
}

/** A collapsible card for one tool call: name, input summary, status, and full input/result. */
export function ToolCard({
  item,
  running,
}: {
  item: ToolItem
  running: boolean
}): React.JSX.Element {
  const status = toolStatus(item, running)
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
        <span className="tool-status">{status}</span>
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
