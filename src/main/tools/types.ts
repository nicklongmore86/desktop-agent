// The tool contract shared with the agent loop. Keep this file structurally
// identical to the agent loop's copy: change both or neither.

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

export interface ToolContext {
  requestApproval(req: ApprovalRequest): Promise<boolean>
  signal: AbortSignal
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
