// Helpers for the tools tests. Not imported by app code.
import { PathGuard } from '../permissions/guard'
import { MemoryAudit, type Sandbox } from '../permissions/test-support'
import type { ToolDeps } from './deps'
import { createTools } from './index'
import type { AgentTool } from './types'

export interface ToolHarness {
  tools: Record<string, AgentTool>
  tool(name: string): AgentTool
  audit: MemoryAudit
  guard: PathGuard
  trashed: string[]
}

/** createTools() over a sandbox: `root` granted, `userData` protected, trash recorded. */
export function toolHarness(sb: Sandbox, overrides: Partial<ToolDeps> = {}): ToolHarness {
  const audit = new MemoryAudit()
  const guard = new PathGuard({ roots: () => [sb.root], protectedPaths: [sb.userData] })
  const trashed: string[] = []
  const list = createTools({
    guard,
    audit,
    trash: (p) => {
      trashed.push(p)
      return Promise.resolve()
    },
    // No Job Object unless a test passes a launcher: the plain kill path, with no note.
    jobLauncher: () => Promise.resolve({ ok: false, reason: null }),
    ...overrides,
  })
  const tools = Object.fromEntries(list.map((t) => [t.name, t]))
  return {
    tools,
    tool(name) {
      const found = tools[name]
      if (!found) throw new Error(`no tool ${name}`)
      return found
    },
    audit,
    guard,
    trashed,
  }
}
