import type { ContentBlock, Message, StopReason, Usage } from '@anthropic-ai/sdk/resources/messages'
import { OpenAICompatError } from '../openai-compat/errors'
import { transcriptToolId } from '../openai-compat/translate'
import { LABEL, responsesError } from './errors'
import { TOOL_NAMESPACE } from './translate'

const MAX_ARGS = 8 * 1024 * 1024
const MAX_ITEMS = 1024

interface Call {
  callId: string
  name: string
  args: string
}
type Terminal =
  | { kind: 'completed'; response: Record<string, unknown> }
  | { kind: 'incomplete'; response: Record<string, unknown> }

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

/**
 * Folds Responses stream events into one Anthropic-shaped assistant message. Only
 * `response.completed` is success (models-and-inference.md, step 3); `response.failed`,
 * error events and a stream that ends without a terminal event all throw.
 */
export class ResponsesAccumulator {
  private deltaText = ''
  private text = ''
  private refusal = false
  private readonly calls: Call[] = []
  private items = 0
  private id = ''
  private terminal: Terminal | null = null
  constructor(
    private readonly model: string,
    /** The names offered in the request; a call to any other name is never returned. */
    private readonly offered: ReadonlySet<string>,
  ) {}

  /** True once a terminal event has arrived; later events are ignored. */
  get done(): boolean {
    return this.terminal !== null
  }

  /** Returns the text delta in this event, if any. */
  add(event: unknown): string {
    if (this.terminal) return ''
    const e = record(event)
    switch (e.type) {
      case 'response.created':
      case 'response.in_progress': {
        const id = record(e.response).id
        if (typeof id === 'string' && !this.id) this.id = id.slice(0, 128)
        return ''
      }
      case 'response.output_text.delta': {
        if (typeof e.delta !== 'string') return ''
        this.deltaText += e.delta
        return e.delta
      }
      case 'response.output_item.done':
        this.addItem(record(e.item))
        return ''
      case 'response.completed':
        this.finish({ kind: 'completed', response: record(e.response) })
        return ''
      case 'response.incomplete':
        this.finish({ kind: 'incomplete', response: record(e.response) })
        return ''
      case 'response.failed':
        // A usage limit can arrive this way after text has already streamed.
        throw responsesError(record(e.response).error, undefined)
      case 'error':
        throw responsesError(e, undefined)
      default:
        // Argument deltas, content-part and reasoning events: the done item carries it all.
        return ''
    }
  }

  private finish(terminal: Terminal): void {
    this.terminal = terminal
    const id = terminal.response.id
    if (typeof id === 'string' && !this.id) this.id = id.slice(0, 128)
    // Items normally stream as output_item.done; fall back to the final output list.
    if (this.items === 0)
      for (const item of list(terminal.response.output)) this.addItem(record(item))
  }

  private addItem(item: Record<string, unknown>): void {
    if (++this.items > MAX_ITEMS)
      throw new OpenAICompatError('protocol', `${LABEL} sent too many output items.`)
    if (item.type === 'message') {
      for (const part of list(item.content)) {
        const p = record(part)
        if (p.type === 'output_text' && typeof p.text === 'string') this.text += p.text
        else if (p.type === 'refusal') this.refusal = true
      }
    } else if (item.type === 'function_call') {
      // Offered tools all sit in one namespace, so each call must name it and an offered tool.
      if (
        item.namespace !== TOOL_NAMESPACE ||
        typeof item.name !== 'string' ||
        !this.offered.has(item.name)
      )
        throw new OpenAICompatError('protocol', `${LABEL} called a tool this app did not offer.`)
      // A call the model did not finish is never run.
      if (item.status !== undefined && item.status !== 'completed')
        throw new OpenAICompatError(
          'protocol',
          `${LABEL} sent an unfinished tool call. The tool was not run.`,
        )
      const args = typeof item.arguments === 'string' ? item.arguments : ''
      if (args.length > MAX_ARGS)
        throw new OpenAICompatError('protocol', `${LABEL} sent oversized tool arguments.`)
      this.calls.push({
        callId: typeof item.call_id === 'string' ? item.call_id : '',
        name: typeof item.name === 'string' ? item.name : '',
        args,
      })
    }
    // Reasoning and any other item types have no transcript form.
  }

  finalMessage(): Message {
    const terminal = this.terminal
    if (!terminal)
      throw new OpenAICompatError('network', `The ${LABEL} response ended unexpectedly. Try again.`)
    let stop: StopReason
    if (terminal.kind === 'incomplete') {
      const reason = record(terminal.response.incomplete_details).reason
      if (reason === 'content_filter') stop = 'refusal'
      else if (reason === 'max_output_tokens') stop = 'max_tokens'
      else
        throw new OpenAICompatError(
          'api',
          `The ${LABEL} response was incomplete. Please try again.`,
        )
    } else
      stop = this.calls.length ? 'tool_use' : this.refusal && !this.text ? 'refusal' : 'end_turn'
    const content: ContentBlock[] = []
    const text = this.text || this.deltaText
    if (text) content.push({ type: 'text', text, citations: null })
    const seen = new Set<string>()
    this.calls.forEach((call, i) => {
      let input: unknown = {}
      const parsed = parseArgs(call.args)
      if (parsed) input = parsed
      if (stop === 'tool_use') {
        // Never execute a call that cannot be answered or whose arguments are not an object.
        // (Its name was checked against the offered tools when the item arrived.)
        if (!call.callId)
          throw new OpenAICompatError('protocol', `${LABEL} sent a tool call without an id.`)
        if (!parsed)
          throw new OpenAICompatError(
            'protocol',
            `${LABEL} sent tool arguments that are not valid JSON. The tool was not run.`,
          )
      }
      // An incomplete response keeps its calls so the agent loop discards the turn.
      let id = transcriptToolId(call.callId || undefined, `${this.id}:${String(i)}`)
      while (seen.has(id)) id = transcriptToolId(undefined, `${id}:${String(i)}`)
      seen.add(id)
      content.push({ type: 'tool_use', id, name: call.name, input, caller: { type: 'direct' } })
    })
    return {
      id: this.id || 'openai-responses',
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      usage: mapUsage(record(terminal.response.usage)),
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

/** Anthropic counts cached prompt tokens separately from input_tokens. */
export function mapUsage(usage: Record<string, unknown>): Usage {
  const input = num(usage.input_tokens)
  const cached = Math.min(input, num(record(usage.input_tokens_details).cached_tokens))
  return {
    input_tokens: input - cached,
    output_tokens: num(usage.output_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  }
}
