// The tool contract shared with the agent loop. This is the only definition:
// src/main/agent/types.ts re-exports it.

export type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ApprovalRequest {
  tool: string
  kind: 'write' | 'move' | 'delete' | 'shell'
  summary: string
  /** Unified diff, or the exact command + cwd. */
  detail?: string
}

/** Who asked for a call: the agent, or the user typing in the command bar. */
export type ToolOrigin = 'agent' | 'user-terminal'

export interface ToolContext {
  requestApproval(req: ApprovalRequest): Promise<boolean>
  signal: AbortSignal
  /** Recorded in the audit log. Absent means 'agent'. */
  origin?: ToolOrigin
}

export interface ToolResult {
  content: string
  isError?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract's default, as specified
export interface AgentTool<I = any> {
  name: string
  description: string
  inputSchema: JsonSchema
  execute(input: I, ctx: ToolContext): Promise<ToolResult>
}
