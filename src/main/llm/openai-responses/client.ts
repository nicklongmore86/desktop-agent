import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { AgentClient, AgentStream } from '../../agent/types'
import { OpenAICompatError } from '../openai-compat/errors'
import {
  connect,
  type Connection,
  type ConnectionOptions,
  type FetchLike,
} from '../openai-compat/http'
import { sseData } from '../openai-compat/stream'
import { LABEL, responsesError, responsesStatusError } from './errors'
import { ResponsesAccumulator } from './stream'
import { offeredToolNames, toResponsesRequest } from './translate'

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
  return {
    messages: {
      stream: (params, { signal }) => new ResponsesStream(connection, model, params, signal),
    },
  }
}

class ResponsesStream implements AgentStream {
  private readonly listeners: ((delta: string) => void)[] = []
  private readonly controller = new AbortController()
  private readonly result: Promise<Message>

  constructor(
    connection: Connection,
    model: string,
    params: MessageCreateParamsNonStreaming,
    signal: AbortSignal,
  ) {
    this.result = this.run(
      connection,
      model,
      params,
      AbortSignal.any([signal, this.controller.signal]),
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
  ): Promise<Message> {
    const body = toResponsesRequest({ ...params, model })
    const { response, touch, done, mapError } = await connection.request('responses', {
      method: 'POST',
      body,
      accept: 'text/event-stream',
      signal,
    })
    try {
      if (!response.body)
        throw new OpenAICompatError('protocol', `${LABEL} sent an empty response.`)
      const type = response.headers.get('content-type') ?? ''
      if (!type.includes('text/event-stream')) {
        const json: unknown = await response.json().catch(() => undefined)
        if (json && typeof json === 'object' && 'error' in json)
          throw responsesError(json.error, undefined, response.headers)
        throw new OpenAICompatError('protocol', `${LABEL} did not stream its response.`)
      }
      const acc = new ResponsesAccumulator(model, offeredToolNames(body))
      for await (const data of sseData(response.body, touch)) {
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
      return acc.finalMessage()
    } catch (error) {
      await response.body?.cancel().catch(() => {})
      throw mapError(error)
    } finally {
      done()
    }
  }

  private emit(text: string): void {
    for (const listener of this.listeners) {
      try {
        listener(text)
      } catch {
        // A failing observer must not break the stream.
      }
    }
  }
}
