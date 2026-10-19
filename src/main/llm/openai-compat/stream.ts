import type { ContentBlock, Message, StopReason, Usage } from '@anthropic-ai/sdk/resources/messages'
import { OpenAICompatError, statusError } from './errors'
import { transcriptToolId } from './translate'

export const MAX_EVENT_BYTES = 8 * 1024 * 1024
export const MAX_STREAM_BYTES = 64 * 1024 * 1024

/** The media type of a Content-Type header, lowercased and without parameters. */
export function mediaType(contentType: string | null): string | undefined {
  const type = contentType?.split(';')[0]?.trim().toLowerCase()
  return type || undefined
}

/** True for `text/event-stream` in any case, with or without parameters such as charset. */
export const isEventStream = (contentType: string | null): boolean =>
  mediaType(contentType) === 'text/event-stream'

/**
 * Yields each SSE `data:` payload (joined across lines) until `[DONE]` or end of body.
 * Comment lines (": OPENROUTER PROCESSING") and other fields are ignored. One event's
 * data is capped at MAX_EVENT_BYTES however many `data:` lines it is split across.
 */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  onBytes: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let eventSize = 0
  let total = 0
  const oversized = (): OpenAICompatError =>
    new OpenAICompatError('protocol', 'The model sent an oversized stream event.')
  const push = (line: string): void => {
    const value = line.slice(line.startsWith('data: ') ? 6 : 5)
    // +1 for the newline each line adds when the event's lines are joined.
    eventSize += value.length + 1
    if (eventSize > MAX_EVENT_BYTES) throw oversized()
    data.push(value)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onBytes()
      total += value.byteLength
      if (total > MAX_STREAM_BYTES)
        throw new OpenAICompatError('protocol', 'The model response was too large.')
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1))
        if (line === '') {
          if (data.length) {
            const payload = data.join('\n')
            data = []
            eventSize = 0
            if (payload.trim() === '[DONE]') return
            yield payload
          }
        } else if (line.startsWith('data:')) {
          push(line)
        }
      }
      // A single line that never ends; split lines are counted in push().
      if (buffer.length > MAX_EVENT_BYTES) throw oversized()
    }
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) push(buffer)
    if (data.length && data.join('\n').trim() !== '[DONE]') yield data.join('\n')
  } finally {
    reader.releaseLock()
  }
}

interface PendingCall {
  providerId?: string
  name: string
  args: string
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

/** Folds `chat.completion.chunk` objects into one Anthropic-shaped assistant message. */
export class ChunkAccumulator {
  private text = ''
  private readonly calls = new Map<number, PendingCall>()
  private finish: string | null = null
  private usage: Record<string, unknown> | null = null
  private id = ''
  constructor(
    private readonly model: string,
    private readonly label: string,
  ) {}

  /** Returns the text delta in this chunk, if any. */
  add(chunk: unknown): string {
    const c = record(chunk)
    // Mid-stream errors (OpenRouter documents these; others send similar shapes).
    if (c.error !== undefined && c.error !== null) {
      const code = record(c.error).code
      throw statusError(typeof code === 'number' ? code : 500, c, this.label)
    }
    if (typeof c.id === 'string' && !this.id) this.id = c.id.slice(0, 128)
    if (c.usage && typeof c.usage === 'object') this.usage = record(c.usage)
    const choices = Array.isArray(c.choices) ? c.choices : []
    const choice = record(choices.find((ch) => num(record(ch).index) === 0) ?? choices[0])
    const delta = record(choice.delta)
    let textDelta = ''
    if (typeof delta.content === 'string' && delta.content) {
      textDelta = delta.content
      this.text += textDelta
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        const call = record(raw)
        const fn = record(call.function)
        const id = typeof call.id === 'string' && call.id ? call.id : undefined
        // `index` is required by the spec; tolerate servers that omit it (new id = new call).
        let index: number
        if (typeof call.index === 'number') index = call.index
        else {
          const last = this.calls.size ? Math.max(...this.calls.keys()) : -1
          const existing = last >= 0 ? this.calls.get(last) : undefined
          index = !existing || (id && existing.providerId !== id) ? last + 1 : last
        }
        const pending = this.calls.get(index) ?? { name: '', args: '' }
        if (id && !pending.providerId) pending.providerId = id
        // OpenAI sends the name once; some servers repeat it on every fragment.
        if (typeof fn.name === 'string' && fn.name !== pending.name) pending.name += fn.name
        if (typeof fn.arguments === 'string') pending.args += fn.arguments
        if (pending.args.length > MAX_EVENT_BYTES)
          throw new OpenAICompatError('protocol', 'The model sent oversized tool arguments.')
        this.calls.set(index, pending)
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason)
      this.finish = choice.finish_reason
    return textDelta
  }

  finalMessage(): Message {
    if (this.finish === 'error')
      throw new OpenAICompatError('api', `The ${this.label} request failed. Please try again.`)
    if (this.finish === null)
      throw new OpenAICompatError(
        'network',
        `The ${this.label} response ended unexpectedly. Try again.`,
      )
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    // Some local servers report "stop" alongside complete tool calls.
    const stop = mapFinish(this.finish, calls.length > 0)
    if (stop === null)
      throw new OpenAICompatError('protocol', `${this.label} returned an unsupported stop reason.`)
    const content: ContentBlock[] = []
    if (this.text) content.push({ type: 'text', text: this.text, citations: null })
    const seen = new Set<string>()
    calls.forEach((call, i) => {
      if (!call.name) {
        if (stop === 'tool_use')
          throw new OpenAICompatError('protocol', `${this.label} sent a tool call without a name.`)
        return
      }
      let input: unknown = {}
      const parsed = parseArgs(call.args)
      if (parsed) input = parsed
      else if (stop === 'tool_use')
        // Never execute a call whose arguments are not a JSON object.
        throw new OpenAICompatError(
          'protocol',
          `${this.label} sent tool arguments that are not valid JSON. The tool was not run.`,
        )
      let id = transcriptToolId(call.providerId, `${this.id}:${String(i)}`)
      while (seen.has(id)) id = transcriptToolId(undefined, `${id}:${String(i)}`)
      seen.add(id)
      content.push({ type: 'tool_use', id, name: call.name, input, caller: { type: 'direct' } })
    })
    return {
      id: this.id || 'openai-compat',
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      usage: mapUsage(this.usage),
    }
  }
}

function parseArgs(args: string): Record<string, unknown> | null {
  if (args.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(args)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function mapFinish(reason: string, hasCalls: boolean): StopReason | null {
  switch (reason) {
    case 'stop':
      return hasCalls ? 'tool_use' : 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    default:
      return hasCalls ? null : 'end_turn'
  }
}

/** Anthropic counts cached prompt tokens separately from input_tokens. */
export function mapUsage(usage: Record<string, unknown> | null): Usage {
  const prompt = num(usage?.prompt_tokens)
  const cached = Math.min(prompt, num(record(usage?.prompt_tokens_details).cached_tokens))
  return {
    input_tokens: prompt - cached,
    output_tokens: num(usage?.completion_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  }
}
