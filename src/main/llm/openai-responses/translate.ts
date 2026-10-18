import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { OpenAICompatError } from '../openai-compat/errors'
import {
  DOCUMENT_PLACEHOLDER,
  IMAGE_PLACEHOLDER,
  TOOL_ERROR_PREFIX,
} from '../openai-compat/translate'

/**
 * ChatGPT plan use asks for function tools grouped in a namespace (preview-limitations.md,
 * "Supported tools"). The model's calls come back tagged with this namespace.
 */
export const TOOL_NAMESPACE = 'workspace'

// Responses request shapes (only the fields this client sends).
export type ResponsesInputItem =
  | { type: 'message'; role: 'user'; content: [{ type: 'input_text'; text: string }] }
  | { type: 'message'; role: 'assistant'; content: [{ type: 'output_text'; text: string }] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; namespace: string }
  | { type: 'function_call_output'; call_id: string; output: string }
export interface ResponsesFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters: Record<string, unknown>
  /** Strict mode (the Responses default) rejects ordinary JSON Schemas. */
  strict: false
}
export interface ResponsesNamespaceTool {
  type: 'namespace'
  name: string
  description: string
  tools: ResponsesFunctionTool[]
}
export interface ResponsesRequest {
  model: string
  instructions?: string
  input: ResponsesInputItem[]
  tools?: ResponsesNamespaceTool[]
  store: false
  stream: true
}

/** Every key this client may send. Anything else is refused before the request goes out. */
export const ALLOWED_BODY_KEYS: readonly string[] = [
  'model',
  'instructions',
  'input',
  'tools',
  'store',
  'stream',
]
/**
 * Fields the ChatGPT plan route rejects (preview-limitations.md, "Unsupported fields" and
 * "Conversation state"). The allowlist already excludes them; tests check both lists.
 */
export const OMITTED_BODY_KEYS: readonly string[] = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
]

function textOf(blocks: readonly ContentBlockParam[] | ToolResultBlockParam['content']): string {
  if (blocks === undefined) return ''
  if (typeof blocks === 'string') return blocks
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push(IMAGE_PLACEHOLDER)
    else if (block.type === 'document') parts.push(DOCUMENT_PLACEHOLDER)
    // Thinking, redacted thinking and server-tool blocks have no Responses input form here.
  }
  return parts.join('\n\n')
}

const userText = (text: string): ResponsesInputItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
})

/**
 * `calls` holds the ids of the tool calls in the assistant message just before `message`
 * that are still unanswered. A tool result must answer one of them, once: the API rejects
 * an output with no matching call, and the app's stored transcripts keep the same
 * pairing (conversation-store.ts). An orphaned result means the history is damaged, so the
 * request is refused rather than sent with the result silently dropped.
 */
function translateMessage(message: MessageParam, calls: Set<string>): ResponsesInputItem[] {
  if (typeof message.content === 'string') {
    if (!message.content) return []
    return message.role === 'user'
      ? [userText(message.content)]
      : [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: message.content }],
          },
        ]
  }
  if (message.role === 'assistant') {
    const out: ResponsesInputItem[] = []
    const text = textOf(message.content.filter((block) => block.type === 'text'))
    if (text)
      out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
    for (const block of message.content)
      if (block.type === 'tool_use')
        out.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
          namespace: TOOL_NAMESPACE,
        })
    return out
  }
  // Outputs answer the calls just before them; other user content follows them.
  const out: ResponsesInputItem[] = message.content
    .filter((block) => block.type === 'tool_result')
    .map((block) => {
      if (!calls.delete(block.tool_use_id))
        throw new OpenAICompatError(
          'protocol',
          'The conversation has a tool result without its tool call, so it was not sent.',
        )
      const output = textOf(block.content)
      return {
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: block.is_error ? `${TOOL_ERROR_PREFIX}${output}` : output,
      }
    })
  const text = textOf(message.content.filter((block) => block.type !== 'tool_result'))
  if (text) out.push(userText(text))
  return out
}

/**
 * The full history goes in `input` on every turn: with `store: false` there is no server
 * state to continue from. The system prompt becomes `instructions` (system-role items are
 * rejected). `max_tokens` and `stop_sequences` have no allowed equivalent and are dropped.
 */
export function toResponsesRequest(params: MessageCreateParamsNonStreaming): ResponsesRequest {
  const system = typeof params.system === 'string' ? params.system : textOf(params.system ?? [])
  const input: ResponsesInputItem[] = []
  let calls = new Set<string>()
  for (const message of params.messages) {
    input.push(...translateMessage(message, calls))
    calls =
      message.role === 'assistant' && typeof message.content !== 'string'
        ? new Set(message.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])))
        : new Set()
  }
  // Hosted (server) tools have no input_schema and are never offered on this route.
  const functions: ResponsesFunctionTool[] = (params.tools ?? []).flatMap((tool) =>
    'input_schema' in tool
      ? [
          {
            type: 'function' as const,
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.input_schema,
            strict: false as const,
          },
        ]
      : [],
  )
  const body: ResponsesRequest = {
    model: params.model,
    ...(system ? { instructions: system } : {}),
    input,
    ...(functions.length
      ? {
          tools: [
            {
              type: 'namespace',
              name: TOOL_NAMESPACE,
              description: "Tools that work with files and commands in the user's granted folders.",
              tools: functions,
            },
          ],
        }
      : {}),
    store: false,
    stream: true,
  }
  assertAllowedBody(body)
  return body
}

export function assertAllowedBody(body: object): void {
  for (const key of Object.keys(body))
    if (!ALLOWED_BODY_KEYS.includes(key))
      throw new OpenAICompatError(
        'invalid_request',
        'The ChatGPT request had an unsupported field.',
      )
}

/** The function names a request offers; the model may call only these. */
export function offeredToolNames(body: ResponsesRequest): ReadonlySet<string> {
  return new Set(body.tools?.flatMap((ns) => ns.tools.map((tool) => tool.name)) ?? [])
}
