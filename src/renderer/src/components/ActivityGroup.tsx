import { useState } from 'react'
import type { ViewItem } from '../chat-state'
import { StatusIcon, type ToolStatus } from './StatusIcon'
import { toolStatus, ToolCard } from './ToolCard'

type ToolItem = Extract<ViewItem, { kind: 'tool' }>

/** While work is under way, this many of the newest steps stay in view. */
export const STREAMING_TAIL = 3

const NO_IDS: ReadonlySet<string> = new Set()

/**
 * One collapsible block for consecutive tool calls: "Used 3 tools", with their statuses.
 * `live` marks the block the agent is still adding to: it shows only the newest steps (and
 * any failure) until the user asks for the rest.
 */
export function ActivityGroup({
  tools,
  running,
  live = false,
  defaultOpen = false,
  waitingIds = NO_IDS,
}: {
  tools: ToolItem[]
  running: boolean
  live?: boolean
  /** Start open (inside a fold the user already opened). */
  defaultOpen?: boolean
  /** Ids of calls waiting for the user's approval. */
  waitingIds?: ReadonlySet<string>
}): React.JSX.Element {
  const statuses = tools.map((tool) => toolStatus(tool, running, waitingIds.has(tool.id)))
  const summary: ToolStatus = statuses.includes('running')
    ? 'running'
    : statuses.includes('queued')
      ? 'queued'
      : statuses.includes('error')
        ? 'error'
        : statuses.includes('no result')
          ? 'no result'
          : 'done'
  const errors = statuses.filter((status) => status === 'error').length
  const denied = statuses.filter((status) => status === 'denied').length
  // Open while work is under way or something failed; the user's choice wins once made.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open =
    chosen ?? (defaultOpen || summary === 'running' || summary === 'queued' || errors > 0)
  const [showAll, setShowAll] = useState(false)
  const count = tools.length
  const working = summary === 'running' || summary === 'queued'
  const label = working
    ? `Using ${String(count)} ${count === 1 ? 'tool' : 'tools'}…`
    : `Used ${String(count)} ${count === 1 ? 'tool' : 'tools'}`

  // Streaming: older finished steps fold away; failures and unfinished steps never do.
  const folded = live && !showAll ? count - STREAMING_TAIL : 0
  const visible = tools.map((tool, index) => {
    const status = statuses[index]
    return (
      index >= folded ||
      status === 'error' ||
      status === 'running' ||
      status === 'queued' ||
      status === 'no result'
    )
  })
  const hidden = visible.filter((shown) => !shown).length

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
        {denied > 0 && <span className="activity-denied">{denied} denied</span>}
      </button>
      <ul className="activity-list" hidden={!open}>
        {hidden > 0 && (
          <li className="activity-earlier">
            <button
              type="button"
              onClick={() => {
                setShowAll(true)
              }}
            >
              Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
            </button>
          </li>
        )}
        {tools.map(
          (tool, index) =>
            visible[index] && (
              <li key={tool.id}>
                <ToolCard item={tool} running={running} queued={waitingIds.has(tool.id)} />
              </li>
            ),
        )}
      </ul>
    </section>
  )
}
