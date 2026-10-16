import { useState } from 'react'
import type { ViewItem } from '../chat-state'
import { formatDuration, workSpan } from '../turns'
import { ActivityGroup } from './ActivityGroup'
import { toolStatus } from './ToolCard'

type ToolItem = Extract<ViewItem, { kind: 'tool' }>

/**
 * A finished turn's tool calls folded under "Worked for 12s". It stays open when a call
 * failed, so a failure is never hidden; the user's choice wins once made.
 */
export function WorkFold({
  tools,
  running,
}: {
  tools: ToolItem[]
  running: boolean
}): React.JSX.Element {
  const failed = tools.some((tool) => toolStatus(tool, running) === 'error')
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? failed
  const span = workSpan(tools)
  return (
    <section className="work-fold" aria-label="Work">
      <button
        type="button"
        className="activity-toggle work-fold-toggle"
        aria-expanded={open}
        onClick={() => {
          setChosen(!open)
        }}
      >
        <span className="activity-chevron" aria-hidden="true" />
        <span className="activity-label">
          {span === null ? 'Worked' : `Worked for ${formatDuration(span)}`}
        </span>
      </button>
      <div className="work-fold-body" hidden={!open}>
        <ActivityGroup tools={tools} running={running} defaultOpen />
      </div>
    </section>
  )
}
