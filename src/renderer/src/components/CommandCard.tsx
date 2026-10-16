import type { ChatItem } from '../../../shared/ipc'
import { commandPrompt } from './CommandBar'
import { hasLatin, SafeLines, SafeText } from './reveal'
import { StatusIcon } from './StatusIcon'
import { toolStatus } from './ToolCard'

/** Shell output can be large; the card shows the start of it (main has already cut the middle). */
const MAX_OUTPUT_CHARS = 20_000

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const field = (input: unknown, key: string): string => {
  const value =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : ''
  return typeof value === 'string' ? value : ''
}

/**
 * A command the user ran from the command bar, as a tool-style card: the prompt and
 * command, its status, and the output run_shell returned. Open by default: the output
 * is what the user asked for. Everything in it is shown as untrusted text.
 */
export function CommandCard({
  item,
  running,
  platform,
}: {
  item: ToolItem
  running: boolean
  platform: string | undefined
}): React.JSX.Element {
  const status = toolStatus(item, running)
  const command = field(item.input, 'command')
  const cwd = field(item.input, 'cwd')
  const latinContext = hasLatin(command) || hasLatin(cwd)
  const content = item.result?.content ?? ''
  const output =
    content.length > MAX_OUTPUT_CHARS ? `${content.slice(0, MAX_OUTPUT_CHARS - 1)}…` : content
  return (
    <section
      className={`command-card tool-${status.replace(' ', '-')}`}
      aria-label="Command you ran"
    >
      <header className="command-card-header">
        <StatusIcon status={status} />
        <span className="command-card-label">You ran</span>
        <span className="command-card-prompt">
          <SafeText text={commandPrompt(cwd, platform)} latinContext={latinContext} />
        </span>
        <span className="tool-status">{status}</span>
      </header>
      <pre
        className="scroll-box untrusted-block command-card-command"
        dir="ltr"
        aria-label="Command"
      >
        <SafeLines text={command} latinContext={latinContext} />
      </pre>
      {item.result && (
        <pre
          className={`scroll-box untrusted-block command-card-output${item.result.isError ? ' tool-error-text' : ''}`}
          dir="ltr"
          tabIndex={0}
          aria-label={item.result.isError ? 'Command error' : 'Command output'}
        >
          <SafeLines text={output} />
        </pre>
      )}
    </section>
  )
}
