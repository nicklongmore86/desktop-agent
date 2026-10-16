import { useState } from 'react'
import type { ChatItem } from '../../../shared/ipc'
import { StatusIcon, type ToolStatus } from './StatusIcon'
import { toolStatus, ToolCard } from './ToolCard'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** One collapsible block for consecutive tool calls: "Used 3 tools", with their statuses. */
export function ActivityGroup({
  tools,
  running,
}: {
  tools: ToolItem[]
  running: boolean
}): React.JSX.Element {
  const statuses = tools.map((tool) => toolStatus(tool, running))
  const summary: ToolStatus = statuses.includes('running')
    ? 'running'
    : statuses.includes('error')
      ? 'error'
      : statuses.includes('no result')
        ? 'no result'
        : 'done'
  const errors = statuses.filter((status) => status === 'error').length
  // Open while work is under way or something failed; the user's choice wins once made.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? (summary === 'running' || summary === 'error')
  const count = tools.length
  const label =
    summary === 'running'
      ? `Using ${String(count)} ${count === 1 ? 'tool' : 'tools'}…`
      : `Used ${String(count)} ${count === 1 ? 'tool' : 'tools'}`

  return (
    <section className="activity-group" aria-label="Tool activity">
      <button
        type="button"
        className="activity-toggle"
        aria-expanded={open}
        onClick={() => {
          setChosen(!open)
        }}
      >
        <span className="activity-chevron" aria-hidden="true" />
        <StatusIcon status={summary} />
        <span className="activity-label">{label}</span>
        {errors > 0 && <span className="activity-errors">{errors} failed</span>}
      </button>
      <ul className="activity-list" hidden={!open}>
        {tools.map((tool) => (
          <li key={tool.id}>
            <ToolCard item={tool} running={running} />
          </li>
        ))}
      </ul>
    </section>
  )
}
