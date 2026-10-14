import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  StopReason,
  Usage,
} from '@anthropic-ai/sdk/resources/messages'
import type { ApprovalRequest, ToolContext, ToolResult } from '../tools/types'

// The tool contract has one definition, owned by the tools module.
export type {
  AgentTool,
  ApprovalRequest,
  JsonSchema,
  ToolContext,
  ToolResult,
} from '../tools/types'

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
  | 'invalid_request'
  | 'permission'
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
  /** This turn's response was dropped (truncated tool calls): roll back its streamed text. */
  | { type: 'response_discarded'; turn: number }
  | { type: 'error'; code: AgentErrorCode; message: string }
export interface RunOptions extends ToolContext {
  onEvent(event: AgentEvent): void
}
export interface RunResult {
  conversation: MessageParam[]
  stopReason: StopReason | AgentErrorCode
}
