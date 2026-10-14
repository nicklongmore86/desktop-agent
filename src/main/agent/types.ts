import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  StopReason,
  Usage,
} from '@anthropic-ai/sdk/resources/messages'

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
// Matches the independently implemented tool contract, including heterogeneous inputs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AgentTool<I = any> {
  name: string
  description: string
  inputSchema: JsonSchema
  execute(input: I, ctx: ToolContext): Promise<ToolResult>
}

export interface AgentStream {
  on(event: 'text', listener: (delta: string) => void): unknown
  finalMessage(): Promise<Message>
  abort(): void
}
export interface AgentClient {
  messages: {
    stream(params: MessageCreateParamsNonStreaming, options: { signal: AbortSignal }): AgentStream
  }
}
export type AgentErrorCode =
  | 'authentication'
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'api'
  | 'aborted'
  | 'max_turns'
  | 'max_tokens'
  | 'refusal'
  | 'context_limit'
  | 'protocol'
export type AgentEvent =
  | { type: 'text_delta'; turn: number; text: string }
  | { type: 'tool_use'; turn: number; id: string; name: string; input: unknown }
  | { type: 'tool_result'; turn: number; id: string; result: ToolResult }
  | { type: 'approval_requested'; turn: number; id: string; request: ApprovalRequest }
  | { type: 'approval_resolved'; turn: number; id: string; approved: boolean }
  | { type: 'turn_complete'; turn: number; stopReason: StopReason | null }
  | { type: 'usage'; turn: number; usage: Usage }
  | { type: 'error'; code: AgentErrorCode; message: string }
export interface RunOptions extends ToolContext {
  onEvent(event: AgentEvent): void
}
export interface RunResult {
  conversation: MessageParam[]
  stopReason: StopReason | AgentErrorCode
}
