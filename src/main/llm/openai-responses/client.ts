import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { AgentClient, AgentStream } from '../../agent/types'
import { MAX_MESSAGE, OpenAICompatError } from '../openai-compat/errors'
import {
  connect,
  readText,
  type Connection,
  type ReadText,
  type SecretCheck,
  type ConnectionOptions,
  type FetchLike,
} from '../openai-compat/http'
import { MAX_EVENT_BYTES, mediaType, sseData } from '../openai-compat/stream'
import { savedToolIds } from '../openai-compat/tool-ids'
import { diagnostics, LABEL, ResponsesError, responsesError, responsesStatusError } from './errors'
import { reasoningItemBytes, ResponsesAccumulator } from './stream'
import {
  hasOutputImages,
  offeredToolNames,
  PLAN_FEATURES_ENV,
  planFeaturesFrom,
  toResponsesRequest,
  type PlanFeatures,
  type RequestFeatures,
  type ResponsesReasoningItem,
  type ResponsesRequest,
  type ToolImageMode,
} from './translate'

/** The only API root ChatGPT plan use allows; never configurable. */
export const RESPONSES_BASE_URL = 'https://api.openai.com/v1'
/** A model `slug` as listChatGPTModels accepts it, and the only form ever sent as `model`. */
export const MODEL_SLUG = /^[A-Za-z0-9._:-]{1,256}$/

export interface ChatGPTConnectionOptions {
  /**
   * Returns a current OAuth access token, called before every request. It is only ever
   * sent as the Authorization header. A rejection becomes "sign in again" unless it is
   * already an OpenAICompatError.
   */
  getAccessToken: () => Promise<string>
  /** For tests. Defaults to the global fetch. */
  fetch?: FetchLike
  /** Abort when no response bytes arrive for this long. Default 120 s. */
  timeoutMs?: number
}

export interface ChatGPTResponsesClientOptions extends ChatGPTConnectionOptions {
  /** The model's `slug` from listChatGPTModels. It replaces the `model` createAgent sends. */
  model: string
  /** For tests. Defaults to PLAN_FEATURES_ENV, which leaves every feature off. */
  features?: Partial<PlanFeatures>
}

/**
 * A request part OpenAI refused (a 400/422 or in-stream failure whose `error.param` names
 * it). It is not sent again for the rest of the app session.
 */
type Refusable = 'parallel_tool_calls' | 'include' | 'reasoning_items'
const refused = new Set<Refusable>()
/** For tests: forget the parts refused so far. */
export function resetRefusedFeatures(): void {
  refused.clear()
}

/** The part of `body` that `error` refuses, if it is one this client can leave out. */
function refusedPart(error: unknown, body: ResponsesRequest): Refusable | undefined {
  if (!(error instanceof ResponsesError) || !error.param || error.toolFormat) return undefined
  if (error.status !== undefined && error.status !== 400 && error.status !== 422) return undefined
  const param = error.param
  if (body.parallel_tool_calls && param === 'parallel_tool_calls') return 'parallel_tool_calls'
  if (body.include && /^include($|\[)/.test(param)) return 'include'
  const index = /^input\[(\d+)\]/.exec(param)?.[1]
  if (index !== undefined && body.input[Number(index)]?.type === 'reasoning')
    return 'reasoning_items'
  return undefined
}

/** Reasoning kept for one client (one run), by the tool calls it led to. */
export const MAX_KEPT_REASONING = 32 * 1024 * 1024
/** Exported for tests. Sizes are UTF-8 bytes as sent (reasoningItemBytes). */
export class ReasoningMemory {
  private readonly kept = new Map<
    string,
    { items: readonly ResponsesReasoningItem[]; size: number }
  >()
  private size = 0
  /** UTF-8 bytes currently kept. */
  get bytes(): number {
    return this.size
  }
  get(ids: readonly string[]): readonly ResponsesReasoningItem[] | undefined {
    return this.kept.get(ids.join('\n'))?.items
  }
  set(ids: readonly string[], items: readonly ResponsesReasoningItem[]): void {
    const key = ids.join('\n')
    const size = items.reduce((total, item) => total + reasoningItemBytes(item), 0)
    // A replaced entry gives back its bytes, and its key becomes the newest.
    const replaced = this.kept.get(key)
    if (replaced) {
      this.kept.delete(key)
      this.size -= replaced.size
    }
    this.kept.set(key, { items, size })
    this.size += size
    // The oldest go first: the model needs the latest calls' reasoning most.
    for (const [key, entry] of this.kept) {
      if (this.size <= MAX_KEPT_REASONING) break
      this.kept.delete(key)
      this.size -= entry.size
    }
  }
}

/** What this client asks for, less anything refused this session. */
class PlanRequests {
  private readonly memory = new ReasoningMemory()
  constructor(private readonly features: PlanFeatures) {}

  private get reasoning(): boolean {
    return this.features.reasoning && !refused.has('reasoning_items')
  }

  current(): RequestFeatures {
    return {
      parallelToolCalls: this.features.parallelToolCalls && !refused.has('parallel_tool_calls'),
      include: this.features.reasoning && !refused.has('include'),
      ...(this.reasoning ? { reasoningFor: (ids) => this.memory.get(ids) } : {}),
    }
  }

  /** Keeps a tool-call response's reasoning for the requests that answer its calls. */
  remember(message: Message, reasoning: readonly ResponsesReasoningItem[]): void {
    if (!this.reasoning || !reasoning.length || message.stop_reason !== 'tool_use') return
    const ids = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []))
    if (ids.length) this.memory.set(ids, reasoning)
  }

  /** The parts this client would send but leaves out because OpenAI refused them. */
  private dropped(): string[] {
    const parts: string[] = []
    if (this.features.parallelToolCalls && refused.has('parallel_tool_calls'))
      parts.push('parallel_tool_calls')
    if (this.features.reasoning && refused.has('include')) parts.push('include')
    if (this.features.reasoning && refused.has('reasoning_items')) parts.push('reasoning items')
    return parts
  }

  /** Adds "without <part>" to an error's app-written details, when it fits. */
  noted(error: unknown): unknown {
    const parts = this.dropped()
    if (!parts.length || !(error instanceof ResponsesError)) return error
    const { details } = error
    if (details && !error.message.endsWith(details)) return error
    const note = `without ${parts.join(', ')}`
    const newDetails = details ? `${details.slice(0, -1)}, ${note}.` : ` Details: ${note}.`
    const message = `${error.message.slice(0, error.message.length - details.length)}${newDetails}`
    if (message.length > MAX_MESSAGE) return error
    return new ResponsesError(error.code, message, {
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}),
      ...(error.providerCode ? { providerCode: error.providerCode } : {}),
      ...(error.param ? { param: error.param } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      retryable: error.retryable,
      toolFormat: error.toolFormat,
      details: newDetails,
    })
  }
}

export function connectChatGPT(options: ChatGPTConnectionOptions): Connection {
  const connection: ConnectionOptions = {
    baseUrl: RESPONSES_BASE_URL,
    flavor: 'openai',
    label: LABEL,
    getAccessToken: options.getAccessToken,
    statusError: responsesStatusError,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }
  return connect(connection)
}

/**
 * An AgentClient over the Responses streaming API for ChatGPT plan use. Every request
 * sends the whole history with `store: false` and `stream: true` to POST /v1/responses.
 * Failures reject finalMessage() with an OpenAICompatError (see openAICompatErrorEvent).
 */
export function createChatGPTResponsesClient(options: ChatGPTResponsesClientOptions): AgentClient {
  const model = options.model.trim()
  if (!MODEL_SLUG.test(model))
    throw new OpenAICompatError('invalid_request', `Choose a ${LABEL} model.`)
  const connection = connectChatGPT(options)
  // Tool images go inside function_call_output until the route refuses one request that
  // has them there; from then on (for this client) they go in a user message instead.
  const images: { mode: ToolImageMode } = { mode: 'output' }
  const plan = new PlanRequests({
    ...planFeaturesFrom(process.env[PLAN_FEATURES_ENV]),
    ...options.features,
  })
  return {
    messages: {
      stream: (params, { signal }) =>
        new ResponsesStream(connection, model, params, signal, images, plan),
    },
  }
}

class ResponsesStream implements AgentStream {
  private readonly listeners: ((delta: string) => void)[] = []
  private readonly controller = new AbortController()
  private readonly result: Promise<Message>
  private emitted = false

  constructor(
    connection: Connection,
    model: string,
    params: MessageCreateParamsNonStreaming,
    signal: AbortSignal,
    images: { mode: ToolImageMode } = { mode: 'output' },
    plan: PlanRequests = new PlanRequests(planFeaturesFrom(undefined)),
  ) {
    this.result = this.run(
      connection,
      model,
      params,
      AbortSignal.any([signal, this.controller.signal]),
      images,
      plan,
    )
    // Callers that never ask for the result must not cause an unhandled rejection.
    this.result.catch(() => {})
  }

  on(_event: 'text', listener: (delta: string) => void): this {
    this.listeners.push(listener)
    return this
  }

  abort(): void {
    this.controller.abort()
  }

  finalMessage(): Promise<Message> {
    return this.result
  }

  private async run(
    connection: Connection,
    model: string,
    params: MessageCreateParamsNonStreaming,
    signal: AbortSignal,
    images: { mode: ToolImageMode },
    plan: PlanRequests,
  ): Promise<Message> {
    // Each fallback removes what it retries without, so this sends at most once per
    // refusable part plus once for tool images, and never after any text has streamed.
    for (;;) {
      const mode = images.mode
      const body = toResponsesRequest({ ...params, model }, mode, plan.current())
      try {
        const { message, reasoning } = await this.send(
          connection,
          model,
          body,
          signal,
          savedToolIds(params.messages),
        )
        plan.remember(message, reasoning)
        return message
      } catch (error) {
        if (this.emitted || signal.aborted) throw plan.noted(error)
        // A refused optional field: leave it out from now on and send once more.
        const part = refusedPart(error, body)
        if (part) {
          refused.add(part)
          continue
        }
        // Refused with images in a tool output: send them as a user message instead, and
        // keep doing so.
        if (
          mode === 'output' &&
          hasOutputImages(body) &&
          error instanceof OpenAICompatError &&
          error.code === 'invalid_request'
        ) {
          images.mode = 'message'
          continue
        }
        throw plan.noted(error)
      }
    }
  }

  private async send(
    connection: Connection,
    model: string,
    body: ResponsesRequest,
    signal: AbortSignal,
    reserved: ReadonlySet<string>,
  ): Promise<{ message: Message; reasoning: readonly ResponsesReasoningItem[] }> {
    const { response, touch, done, mapError, isSecret } = await connection.request('responses', {
      method: 'POST',
      body,
      accept: 'text/event-stream',
      signal,
    })
    let stream = response.body
    try {
      if (!stream) throw new OpenAICompatError('protocol', `${LABEL} sent an empty response.`)
      const acc = new ResponsesAccumulator(
        model,
        offeredToolNames(body),
        { status: response.status, headers: response.headers, isSecret },
        reserved,
      )
      const type = mediaType(response.headers.get('content-type'))
      if (type !== 'text/event-stream') {
        // No Content-Type at all: still a stream if the body starts like one.
        const peeked = type === undefined ? await peek(stream) : undefined
        if (peeked) stream = peeked.body
        if (!peeked?.sse) {
          const message = await notStreamed(response, stream, touch, acc, isSecret)
          stream = null
          if (signal.aborted) throw new Error('aborted')
          for (const block of message.content) if (block.type === 'text') this.emit(block.text)
          return { message, reasoning: acc.reasoningItems() }
        }
      }
      for await (const data of sseData(stream, touch)) {
        let event: unknown
        try {
          event = JSON.parse(data)
        } catch {
          throw new OpenAICompatError('protocol', `${LABEL} sent a malformed stream event.`)
        }
        const text = acc.add(event)
        if (text && !signal.aborted) this.emit(text)
        // The terminal event ends the response; nothing after it is read.
        if (acc.done) break
      }
      if (signal.aborted) throw new Error('aborted')
      return { message: acc.finalMessage(), reasoning: acc.reasoningItems() }
    } catch (error) {
      await stream?.cancel().catch(() => {})
      throw mapError(error)
    } finally {
      done()
    }
  }

  private emit(text: string): void {
    this.emitted = true
    for (const listener of this.listeners) {
      try {
        listener(text)
      } catch {
        // A failing observer must not break the stream.
      }
    }
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** The first bytes of a stream begin an SSE field (`data:`, `event:`, `id:`, `retry:`) or comment. */
const SSE_START = /^\uFEFF?(data|event|id|retry)?:/

/**
 * Reads the first bytes of a body that has no Content-Type, and returns a body that still
 * yields them, plus whether they look like SSE.
 */
async function peek(
  source: ReadableStream<Uint8Array>,
): Promise<{ sse: boolean; body: ReadableStream<Uint8Array> }> {
  const reader = source.getReader()
  const head: Uint8Array[] = []
  let size = 0
  let ended = false
  while (size < 16) {
    const { done, value } = await reader.read()
    if (done) {
      ended = true
      break
    }
    head.push(value)
    size += value.byteLength
  }
  const first = Buffer.concat(head)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.byteLength) controller.enqueue(new Uint8Array(first))
      if (ended) controller.close()
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return { sse: SSE_START.test(new TextDecoder().decode(first)), body }
}

/**
 * A 2xx response that is not an event stream. A complete Responses object (`object:
 * "response"`) is accepted on the same terms as the stream's terminal event; an error
 * body is mapped by its code; anything else is a protocol error. Every failure message
 * carries diagnostics() (status, media type, body kind, code, param, request id) and
 * never the body's own text.
 */
async function notStreamed(
  response: Response,
  body: ReadableStream<Uint8Array>,
  touch: () => void,
  acc: ResponsesAccumulator,
  isSecret: SecretCheck,
): Promise<Message> {
  const read = await readText(body, MAX_EVENT_BYTES, touch)
  let json: unknown
  if (read.ok && read.text.trim()) {
    try {
      json = JSON.parse(read.text)
    } catch {
      json = undefined
    }
  }
  const r = record(json)
  const context = { httpStatus: response.status, isSecret }
  if (r.object === 'response') {
    switch (r.status) {
      case 'completed':
        acc.add({ type: 'response.completed', response: r })
        return acc.finalMessage()
      case 'incomplete':
        acc.add({ type: 'response.incomplete', response: r })
        return acc.finalMessage()
      case 'failed':
        throw responsesError(r.error, undefined, response.headers, {
          ...context,
          body: 'body response',
          responseStatus: 'failed',
        })
    }
  }
  if (Object.keys(record(r.error)).length)
    throw responsesError(r.error, undefined, response.headers, context)
  const message = `${LABEL} did not stream its response. Try again, and report this problem if it continues.`
  throw new OpenAICompatError(
    'protocol',
    `${message}${diagnostics({
      status: response.status,
      headers: response.headers,
      body: bodyKind(read, json),
      ...(r.object === 'response' ? { responseStatus: r.status } : {}),
      isSecret,
      max: MAX_MESSAGE - message.length,
    })}`,
    { status: response.status },
  )
}

/** What a non-stream body was, in app-written words only. */
function bodyKind(read: ReadText, json: unknown): string {
  if (!read.ok) return read.reason === 'too_large' ? 'body too large' : 'body unreadable'
  if (read.text.trim() === '') return 'body empty'
  if (json === undefined) return 'body not JSON'
  const r = record(json)
  if (r.object === 'response') return 'body response'
  if (typeof r.detail === 'string') return 'body detail'
  return 'body other JSON'
}
