import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { IMAGE_LABEL_PREFIX } from '../../agent/images'
import { OpenAICompatError } from '../openai-compat/errors'
import {
  DOCUMENT_PLACEHOLDER,
  IMAGE_PLACEHOLDER,
  imageDataUrl,
  TOOL_ERROR_PREFIX,
  TOOL_IMAGES_NOTE,
  type ToolResultPart,
} from '../openai-compat/translate'

/**
 * ChatGPT plan use asks for function tools grouped in a namespace (preview-limitations.md,
 * "Supported tools"). The model's calls come back tagged with this namespace.
 */
export const TOOL_NAMESPACE = 'workspace'

// Responses request shapes (only the fields this client sends).
export type ResponsesInputContent =
  { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }
export type ResponsesInputItem =
  | { type: 'message'; role: 'user'; content: ResponsesInputContent[] }
  | { type: 'message'; role: 'assistant'; content: [{ type: 'output_text'; text: string }] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; namespace: string }
  | {
      type: 'function_call_output'
      call_id: string
      output: string | ResponsesInputContent[]
    }
  | ResponsesReasoningItem

/**
 * A reasoning item from an earlier response in the same run, sent back so the model keeps
 * its reasoning between tool calls (reasoning guide, "Keeping reasoning items in context").
 * It lives only in the client's memory: it never enters the Anthropic-shaped transcript,
 * so it is never saved, shown, logged or put in an error message.
 */
export interface ResponsesReasoningItem {
  type: 'reasoning'
  id?: string
  summary: { type: 'summary_text'; text: string }[]
  encrypted_content: string
}

/**
 * Request features the ChatGPT plan docs neither list as supported nor as rejected
 * (preview-limitations.md lists only what to omit). They stay off unless turned on with
 * PLAN_FEATURES_ENV, and each is dropped for the session once OpenAI refuses it.
 */
export interface PlanFeatures {
  /** Send `parallel_tool_calls: true` (the Responses default for other routes). */
  parallelToolCalls: boolean
  /** Ask for encrypted reasoning and send reasoning items back within a run. */
  reasoning: boolean
}
export const PLAN_FEATURES_ENV = 'DESKTOP_AGENT_CHATGPT_PLAN_FEATURES'
/** Off by default: `parallel_tool_calls`, `reasoning`, or `all`, comma-separated. */
export function planFeaturesFrom(value: string | undefined): PlanFeatures {
  const names = new Set(
    (value ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  )
  const all = names.has('all')
  return {
    parallelToolCalls: all || names.has('parallel_tool_calls'),
    reasoning: all || names.has('reasoning'),
  }
}
export const INCLUDE_REASONING = 'reasoning.encrypted_content'

/** What one request carries beyond the base fields; the client turns parts off on refusal. */
export interface RequestFeatures {
  parallelToolCalls?: boolean
  /** Send `include: ["reasoning.encrypted_content"]`. */
  include?: boolean
  /** Reasoning items for an assistant message, by its tool_use ids, if any are kept. */
  reasoningFor?: (toolUseIds: readonly string[]) => readonly ResponsesReasoningItem[] | undefined
}

/**
 * Where tool images go: inside `function_call_output` (the Responses API's own form), or,
 * if the route refuses that, in a user message right after the outputs, marked as tool
 * output (as for Chat Completions).
 */
export type ToolImageMode = 'output' | 'message'
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
  parallel_tool_calls?: true
  include?: [typeof INCLUDE_REASONING]
  store: false
  stream: true
}

/** Every key this client may send. Anything else is refused before the request goes out. */
export const ALLOWED_BODY_KEYS: readonly string[] = [
  'model',
  'instructions',
  'input',
  'tools',
  'parallel_tool_calls',
  'include',
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

function textOf(
  blocks: readonly (ContentBlockParam | ToolResultPart)[] | string | undefined,
): string {
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

/** Text and images as Responses input content (other blocks as textOf words them). */
function inputContent(
  blocks: readonly (ContentBlockParam | ToolResultPart)[],
): ResponsesInputContent[] {
  const parts: ResponsesInputContent[] = []
  for (const block of blocks) {
    const url = block.type === 'image' ? imageDataUrl(block) : null
    if (url) parts.push({ type: 'input_image', image_url: url, detail: 'auto' })
    else {
      const text = textOf([block])
      if (text) parts.push({ type: 'input_text', text })
    }
  }
  return parts
}

const blocksOf = (content: ToolResultBlockParam['content']): ToolResultPart[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
const hasImage = (blocks: readonly (ContentBlockParam | ToolResultPart)[]): boolean =>
  blocks.some((block) => block.type === 'image')

/**
 * `calls` holds the ids of the tool calls in the assistant message just before `message`
 * that are still unanswered. A tool result must answer one of them, once: the API rejects
 * an output with no matching call, and the app's stored transcripts keep the same
 * pairing (conversation-store.ts). An orphaned result means the history is damaged, so the
 * request is refused rather than sent with the result silently dropped.
 */
function translateMessage(
  message: MessageParam,
  calls: Set<string>,
  mode: ToolImageMode,
  reasoningFor?: RequestFeatures['reasoningFor'],
): ResponsesInputItem[] {
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
    // The model's reasoning came before its text and calls in the response's output.
    const ids = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []))
    const reasoning = ids.length ? reasoningFor?.(ids) : undefined
    if (reasoning) out.push(...reasoning.map((item) => ({ ...item, summary: [...item.summary] })))
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
  const toolImages: ResponsesInputContent[] = []
  const out: ResponsesInputItem[] = message.content
    .filter((block) => block.type === 'tool_result')
    .map((block): ResponsesInputItem => {
      if (!calls.delete(block.tool_use_id))
        throw new OpenAICompatError(
          'protocol',
          'The conversation has a tool result without its tool call, so it was not sent.',
        )
      const blocks = blocksOf(block.content)
      const prefix = block.is_error ? TOOL_ERROR_PREFIX : ''
      if (hasImage(blocks) && mode === 'output') {
        const parts = inputContent(blocks)
        const first = parts[0]
        if (prefix && first?.type === 'input_text') first.text = `${prefix}${first.text}`
        return { type: 'function_call_output', call_id: block.tool_use_id, output: parts }
      }
      if (hasImage(blocks))
        toolImages.push(
          ...inputContent(
            blocks.filter(
              (part) =>
                part.type === 'image' ||
                (part.type === 'text' && part.text.startsWith(IMAGE_LABEL_PREFIX)),
            ),
          ),
        )
      const output = textOf(blocks.filter((part) => part.type !== 'image'))
      return {
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: `${prefix}${output}`,
      }
    })
  if (toolImages.length)
    out.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: TOOL_IMAGES_NOTE }, ...toolImages],
    })
  const rest = message.content.filter((block) => block.type !== 'tool_result')
  if (hasImage(rest)) {
    const content = inputContent(rest)
    if (content.length) out.push({ type: 'message', role: 'user', content })
  } else {
    const text = textOf(rest)
    if (text) out.push(userText(text))
  }
  return out
}

/** True when a request puts images inside function_call_output (see ToolImageMode). */
export function hasOutputImages(body: ResponsesRequest): boolean {
  return body.input.some(
    (item) =>
      item.type === 'function_call_output' &&
      Array.isArray(item.output) &&
      item.output.some((part) => part.type === 'input_image'),
  )
}

/**
 * The full history goes in `input` on every turn: with `store: false` there is no server
 * state to continue from. The system prompt becomes `instructions` (system-role items are
 * rejected). `max_tokens` and `stop_sequences` have no allowed equivalent and are dropped.
 */
export function toResponsesRequest(
  params: MessageCreateParamsNonStreaming,
  mode: ToolImageMode = 'output',
  features: RequestFeatures = {},
): ResponsesRequest {
  const system = typeof params.system === 'string' ? params.system : textOf(params.system ?? [])
  const input: ResponsesInputItem[] = []
  let calls = new Set<string>()
  // Reasoning goes back only for the calls since the last message the user typed: earlier
  // turns' reasoning is ignored by the model anyway (reasoning guide).
  const turnStart = params.messages.findLastIndex(
    (m) =>
      m.role === 'user' &&
      (typeof m.content === 'string' || m.content.some((block) => block.type !== 'tool_result')),
  )
  params.messages.forEach((message, index) => {
    const reasoningFor = index > turnStart ? features.reasoningFor : undefined
    input.push(...translateMessage(message, calls, mode, reasoningFor))
    calls =
      message.role === 'assistant' && typeof message.content !== 'string'
        ? new Set(message.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])))
        : new Set()
  })
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
    ...(features.parallelToolCalls && functions.length ? { parallel_tool_calls: true } : {}),
    ...(features.include ? { include: [INCLUDE_REASONING] } : {}),
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

/** True when a request sends reasoning items back. */
export const hasReasoningInput = (body: ResponsesRequest): boolean =>
  body.input.some((item) => item.type === 'reasoning')

/** The function names a request offers; the model may call only these. */
export function offeredToolNames(body: ResponsesRequest): ReadonlySet<string> {
  return new Set(body.tools?.flatMap((ns) => ns.tools.map((tool) => tool.name)) ?? [])
}
