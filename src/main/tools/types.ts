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

/**
 * Who asked for a call: the agent, the user typing in the command bar, or the user acting
 * in the app itself (attaching a file, "Copy into folder…").
 */
export type ToolOrigin = 'agent' | 'user-terminal' | 'user'

export interface ToolContext {
  requestApproval(req: ApprovalRequest): Promise<boolean>
  signal: AbortSignal
  /** Recorded in the audit log. Absent means 'agent'. */
  origin?: ToolOrigin
}

/** An image a tool returns for vision-capable models. */
export interface ToolImage {
  mime: 'image/png' | 'image/jpeg'
  data: Uint8Array
  width: number
  height: number
  /** Short label the model sees next to the image, e.g. "page 3". */
  label?: string
}

export interface ToolResult {
  content: string
  /** Images for vision-capable models. `content` must still make sense without them. */
  images?: ToolImage[]
  isError?: boolean
  /**
   * Set (by defineTool) when the call failed because the user declined its approval.
   * The chat view shows such calls as denied; it never infers that from `content`.
   */
  declined?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract's default, as specified
export interface AgentTool<I = any> {
  name: string
  description: string
  inputSchema: JsonSchema
  execute(input: I, ctx: ToolContext): Promise<ToolResult>
}
