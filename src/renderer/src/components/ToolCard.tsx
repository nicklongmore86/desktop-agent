import type { ChatItem } from '../../../shared/ipc'

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
  return truncate(summary.replace(/\s+/g, ' ').trim(), MAX_SUMMARY)
}

function stringify(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/** A collapsible card for one tool call: name, input summary, status, and full input/result. */
export function ToolCard({
  item,
  running,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
  running: boolean
}): React.JSX.Element {
  const status = item.result
    ? item.result.isError
      ? 'error'
      : 'done'
    : running
      ? 'running'
      : 'no result'
  const content = item.result?.content ?? ''
  return (
    <details className={`tool-card tool-${status.replace(' ', '-')}`}>
      <summary>
        <span className="tool-name">{item.name}</span>
        <span className="tool-input">{summarizeInput(item.input)}</span>
        <span className="tool-status">{status}</span>
      </summary>
      <div className="tool-body">
        <h4>Input</h4>
        <pre className="scroll-box">{stringify(item.input)}</pre>
        {item.result && (
          <>
            <h4>{item.result.isError ? 'Error' : 'Result'}</h4>
            <pre className={`scroll-box${item.result.isError ? ' tool-error-text' : ''}`}>
              {truncate(content, MAX_RESULT_CHARS)}
            </pre>
          </>
        )}
      </div>
    </details>
  )
}
