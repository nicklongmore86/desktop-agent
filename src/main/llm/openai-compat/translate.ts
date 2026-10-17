import { createHash } from 'node:crypto'
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import type { OpenAICompatFlavor } from './base-url'

// Chat Completions request shapes (only the fields this client sends).
export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
export interface ChatTool {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}
export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: ChatTool[]
  max_tokens?: number
  max_completion_tokens?: number
  stop?: string[]
}

export const IMAGE_PLACEHOLDER = '[Image omitted: this model connection does not accept images.]'
export const DOCUMENT_PLACEHOLDER =
  '[Document omitted: this model connection does not accept documents.]'
/** Marks a failed tool result: Chat Completions tool messages have no is_error field. */
export const TOOL_ERROR_PREFIX = '[tool error] '

/**
 * Transcript tool ids must suit every provider the transcript may later be sent to (Claude
 * requires ^[a-zA-Z0-9_-]+$). Valid ids are kept; anything else maps to a stable hash.
 */
export function transcriptToolId(providerId: string | undefined, fallback: string): string {
  if (providerId && /^[A-Za-z0-9_-]{1,64}$/.test(providerId)) return providerId
  const seed = providerId ?? fallback
  return `call_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

function textOf(blocks: readonly ContentBlockParam[] | ToolResultBlockParam['content']): string {
  if (blocks === undefined) return ''
  if (typeof blocks === 'string') return blocks
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push(IMAGE_PLACEHOLDER)
    else if (block.type === 'document') parts.push(DOCUMENT_PLACEHOLDER)
    // Thinking, redacted thinking and server-tool blocks have no Chat Completions form.
  }
  return parts.join('\n\n')
}

function translateMessage(message: MessageParam): ChatMessage[] {
  if (typeof message.content === 'string')
    return message.content ? [{ role: message.role, content: message.content }] : []
  if (message.role === 'assistant') {
    const toolCalls: ChatToolCall[] = message.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }))
    const text = textOf(message.content.filter((block) => block.type === 'text'))
    if (!text && !toolCalls.length) return []
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    ]
  }
  // Tool messages must directly follow the assistant message that called them, so they
  // come first; any other user content follows as a separate user message.
  const out: ChatMessage[] = message.content
    .filter((block) => block.type === 'tool_result')
    .map((block) => {
      const content = textOf(block.content)
      return {
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: block.is_error ? `${TOOL_ERROR_PREFIX}${content}` : content,
      }
    })
  const text = textOf(message.content.filter((block) => block.type !== 'tool_result'))
  if (text) out.push({ role: 'user', content: text })
  return out
}

export function toChatRequest(
  params: MessageCreateParamsNonStreaming,
  flavor: OpenAICompatFlavor,
): ChatRequest {
  const messages: ChatMessage[] = []
  const system = typeof params.system === 'string' ? params.system : textOf(params.system ?? [])
  if (system) messages.push({ role: 'system', content: system })
  for (const message of params.messages) messages.push(...translateMessage(message))
  const tools: ChatTool[] = (params.tools ?? []).flatMap((tool) =>
    'input_schema' in tool
      ? [
          {
            type: 'function' as const,
            function: {
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              parameters: tool.input_schema,
            },
          },
        ]
      : [],
  )
  return {
    model: params.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length ? { tools } : {}),
    // OpenAI deprecated max_tokens (reasoning models reject it); the others document max_tokens.
    ...(flavor === 'openai'
      ? { max_completion_tokens: params.max_tokens }
      : { max_tokens: params.max_tokens }),
    ...(params.stop_sequences?.length ? { stop: params.stop_sequences } : {}),
  }
}
