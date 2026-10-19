import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { AgentClient, AgentStream } from '../../agent/types'
import { OpenAICompatError, statusError } from './errors'
import { connect, type Connection, type ConnectionOptions } from './http'
import { ChunkAccumulator, isEventStream, sseData } from './stream'
import { toChatRequest } from './translate'

export interface OpenAICompatClientOptions extends ConnectionOptions {
  /** The provider's model id. It replaces the `model` createAgent sends. */
  model: string
}

/**
 * An AgentClient over the Chat Completions streaming API. Requests and responses are
 * translated to and from the app's Anthropic-shaped transcript inside this client.
 * Failures reject finalMessage() with an OpenAICompatError (see openAICompatErrorEvent).
 */
export function createOpenAICompatClient(options: OpenAICompatClientOptions): AgentClient {
  const model = options.model.trim()
  const connection = connect(options)
  if (!model || model.length > 256)
    throw new OpenAICompatError('invalid_request', `Choose a ${connection.label} model.`)
  return {
    messages: {
      stream: (params, { signal }) => new CompatStream(connection, model, params, signal),
    },
  }
}

class CompatStream implements AgentStream {
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
    const { response, touch, done, mapError } = await connection.request('chat/completions', {
      method: 'POST',
      body: toChatRequest({ ...params, model }, connection.flavor),
      accept: 'text/event-stream',
      signal,
    })
    try {
      if (!response.body)
        throw new OpenAICompatError('protocol', `${connection.label} sent an empty response.`)
      if (!isEventStream(response.headers.get('content-type'))) {
        // Some servers report a failure as a JSON body with a 200 status.
        const body: unknown = await response.json().catch(() => undefined)
        if (body && typeof body === 'object' && 'error' in body)
          throw statusError(500, body, connection.label)
        throw new OpenAICompatError(
          'protocol',
          `${connection.label} did not stream its response. Check the base URL.`,
        )
      }
      const acc = new ChunkAccumulator(model, connection.label)
      for await (const data of sseData(response.body, touch)) {
        let chunk: unknown
        try {
          chunk = JSON.parse(data)
        } catch {
          throw new OpenAICompatError(
            'protocol',
            `${connection.label} sent a malformed stream event.`,
          )
        }
        const text = acc.add(chunk)
        if (text && !signal.aborted) this.emit(text)
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
