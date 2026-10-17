import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  StopReason,
  ToolResultBlockParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages'
import { toGeminiSchema } from './schema'
import type {
  CallRecord,
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiPart,
  GeminiRequest,
  GeminiUsageMetadata,
} from './types'

/**
 * Stand-in signature for a function call Gemini did not produce in this process
 * (history from disk or another model). Documented as the way to skip
 * validation: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
 */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator'
export const IMAGE_PLACEHOLDER = '[Image omitted: not sent to Gemini]'
export const ATTACHMENT_PLACEHOLDER = '[Attachment omitted: not sent to Gemini]'

const systemText = (system: MessageCreateParamsNonStreaming['system']): string =>
  typeof system === 'string' ? system : (system ?? []).map((block) => block.text).join('\n\n')

function resultText(content: ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content
  return (content ?? [])
    .map((block) =>
      block.type === 'text'
        ? block.text
        : block.type === 'image'
          ? IMAGE_PLACEHOLDER
          : ATTACHMENT_PLACEHOLDER,
    )
    .join('\n')
}

/**
 * Translates an Anthropic request into a Gemini `generateContent` body.
 * `calls` holds what this client learned about each tool_use id it issued.
 */
export function toGeminiRequest(
  params: MessageCreateParamsNonStreaming,
  calls: ReadonlyMap<string, CallRecord>,
): GeminiRequest {
  const names = new Map<string, string>()
  const contents: GeminiContent[] = []
  for (const message of params.messages) {
    const parts = toParts(message, calls, names)
    if (!parts.length) continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    const previous = contents.at(-1)
    // Gemini expects alternating turns; merge neighbours that share a role.
    if (previous?.role === role) previous.parts.push(...parts)
    else contents.push({ role, parts })
  }
  const declarations: GeminiFunctionDeclaration[] = (params.tools ?? []).flatMap((tool) => {
    if (!('input_schema' in tool)) return []
    const parameters = toGeminiSchema(tool.input_schema)
    const declaration: GeminiFunctionDeclaration = { name: tool.name }
    if (tool.description) declaration.description = tool.description
    // An object with no properties is rejected as `parameters`; a function without them is not.
    if (parameters.properties) declaration.parameters = parameters
    return [declaration]
  })
  const request: GeminiRequest = {
    contents,
    generationConfig: { maxOutputTokens: params.max_tokens },
  }
  const system = systemText(params.system)
  if (system.trim()) request.systemInstruction = { parts: [{ text: system }] }
  if (declarations.length) request.tools = [{ functionDeclarations: declarations }]
  return request
}

function toParts(
  message: MessageParam,
  calls: ReadonlyMap<string, CallRecord>,
  names: Map<string, string>,
): GeminiPart[] {
  const blocks: ContentBlockParam[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
  const parts: GeminiPart[] = []
  let signed = false
  let firstCall: GeminiPart | undefined
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text) parts.push({ text: block.text })
        break
      case 'image':
        parts.push({ text: IMAGE_PLACEHOLDER })
        break
      case 'document':
      case 'search_result':
        parts.push({ text: ATTACHMENT_PLACEHOLDER })
        break
      case 'tool_use': {
        names.set(block.id, block.name)
        const record = calls.get(block.id)
        const part: GeminiPart = {
          functionCall: {
            ...(record?.geminiId ? { id: record.geminiId } : {}),
            name: block.name,
            args: block.input ?? {},
          },
        }
        if (record?.signature) {
          part.thoughtSignature = record.signature
          signed = true
        }
        firstCall ??= part
        parts.push(part)
        break
      }
      case 'tool_result': {
        const record = calls.get(block.tool_use_id)
        const text = resultText(block.content)
        parts.push({
          functionResponse: {
            ...(record?.geminiId ? { id: record.geminiId } : {}),
            name: names.get(block.tool_use_id) ?? 'unknown_tool',
            // Errors stay distinguishable: Gemini's convention is `output` or `error`.
            response: block.is_error ? { error: text } : { output: text },
          },
        })
        break
      }
      default:
        // Thinking blocks and other providers' server-tool blocks have no Gemini equivalent.
        break
    }
  }
  // Each model step's first function call must carry a signature (Gemini 3+).
  if (firstCall && !signed) firstCall.thoughtSignature = SKIP_SIGNATURE
  return parts
}

/** finishReason values: https://ai.google.dev/api/generate-content#FinishReason */
export function toStopReason(
  finishReason: string | undefined,
  hasCalls: boolean,
): StopReason | null {
  switch (finishReason) {
    case 'STOP':
      return hasCalls ? 'tool_use' : 'end_turn'
    case 'MAX_TOKENS':
    case 'CONTINUATION':
      return 'max_tokens'
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
    case 'PUP_LIMITED_DISABLED':
      return 'refusal'
    default:
      return null
  }
}

/** Gemini bills thinking as output; cached prompt tokens are reported separately. */
export function toUsage(meta: GeminiUsageMetadata | undefined): Usage {
  const n = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  const cached = n(meta?.cachedContentTokenCount)
  const thoughts = n(meta?.thoughtsTokenCount)
  return {
    input_tokens: Math.max(
      0,
      n(meta?.promptTokenCount) + n(meta?.toolUsePromptTokenCount) - cached,
    ),
    output_tokens: n(meta?.candidatesTokenCount) + thoughts,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: thoughts ? { thinking_tokens: thoughts } : null,
    server_tool_use: null,
    service_tier: null,
  }
}
