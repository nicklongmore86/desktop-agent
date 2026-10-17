import { randomBytes } from 'node:crypto'
import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages'
import type { AgentClient, AgentStream } from '../../agent/types'
import { GeminiError, httpError } from './errors'
import { toGeminiRequest, toStopReason, toUsage } from './translate'
import { GEMINI_HOST, type CallRecord, type GeminiResponseChunk } from './types'

export interface GeminiClientOptions {
  apiKey: string
  /** A Gemini model id such as `gemini-2.5-flash`. Used for every request, whatever `params.model` says. */
  model: string
  /** Tests only: a fetch that serves the fixed Gemini URLs from a local server. */
  fetch?: typeof fetch
}

/** Silence before the stream is considered stalled. */
const IDLE_TIMEOUT_MS = 120_000
/** Calls remembered for replaying ids and thought signatures; old ones fall back to the skip value. */
const MAX_REMEMBERED_CALLS = 2_000
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function modelPath(model: string): string {
  const id = model.startsWith('models/') ? model.slice('models/'.length) : model
  if (!MODEL_ID.test(id))
    throw new GeminiError('invalid_request', 'The Gemini model name is not valid.')
  return `models/${id}`
}

/** Fetch with the fixed host, the key in a header and redirects refused. */
export async function geminiFetch(
  fetchImpl: typeof fetch,
  path: string,
  apiKey: string,
  init: { method: 'GET' | 'POST'; body?: string; accept?: string; signal: AbortSignal },
): Promise<Response> {
  const url = new URL(path, GEMINI_HOST)
  if (url.origin !== GEMINI_HOST) throw new GeminiError('invalid_request', 'Invalid Gemini URL.')
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: {
        'x-goog-api-key': apiKey,
        accept: init.accept ?? 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'error',
      signal: init.signal,
    })
  } catch {
    if (init.signal.aborted) throw new GeminiError('aborted', 'Gemini request cancelled.')
    throw new GeminiError(
      'network',
      'Could not connect to Gemini. Check your connection and try again.',
    )
  }
  if (response.ok) return response
  let body: unknown
  try {
    body = JSON.parse(await response.text())
  } catch {
    body = undefined
  }
  throw httpError(response.status, body, apiKey, response.headers.get('retry-after'))
}

/** Yields each `data:` payload of a server-sent event stream. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = done ? '' : (events.pop() ?? '')
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data) yield data
      }
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * An AgentClient over the Gemini API (`streamGenerateContent`, API key only).
 * Requests arrive in Anthropic Messages format and replies leave in it; the
 * translation, including Gemini's function-call ids and thought signatures,
 * stays inside this client. Signatures are kept in memory, never in the transcript.
 */
export function createGeminiClient({
  apiKey,
  model,
  fetch: fetchImpl = fetch,
}: GeminiClientOptions): AgentClient {
  const calls = new Map<string, CallRecord>()
  const remember = (id: string, record: CallRecord): void => {
    calls.set(id, record)
    if (calls.size > MAX_REMEMBERED_CALLS) {
      const oldest = calls.keys().next()
      if (!oldest.done) calls.delete(oldest.value)
    }
  }

  return {
    messages: {
      stream(params: MessageCreateParamsNonStreaming, { signal }): AgentStream {
        const listeners: ((delta: string) => void)[] = []
        const controller = new AbortController()
        const abort = (): void => {
          controller.abort()
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })

        async function run(): Promise<Message> {
          const path = `/v1beta/${modelPath(model)}:streamGenerateContent?alt=sse`
          const body = JSON.stringify(toGeminiRequest(params, calls))
          let idle: ReturnType<typeof setTimeout> | undefined
          const idleState = { stalled: false }
          const touch = (): void => {
            clearTimeout(idle)
            idle = setTimeout(() => {
              idleState.stalled = true
              controller.abort()
            }, IDLE_TIMEOUT_MS)
          }
          const content: ContentBlock[] = []
          let finishReason: string | undefined
          let blockReason: string | undefined
          let usage: GeminiResponseChunk['usageMetadata']
          let modelVersion: string | undefined
          let malformed = false
          try {
            touch()
            const response = await geminiFetch(fetchImpl, path, apiKey, {
              method: 'POST',
              body,
              accept: 'text/event-stream',
              signal: controller.signal,
            })
            if (!response.body) throw new GeminiError('protocol', 'Gemini sent an empty response.')
            for await (const data of sseData(response.body)) {
              touch()
              let chunk: GeminiResponseChunk & { error?: unknown }
              try {
                chunk = JSON.parse(data) as typeof chunk
              } catch {
                throw new GeminiError('protocol', 'Gemini sent an unreadable response.')
              }
              if (typeof chunk.error === 'object' && chunk.error !== null) {
                const code = 'code' in chunk.error ? chunk.error.code : undefined
                throw httpError(typeof code === 'number' ? code : 500, chunk, apiKey)
              }
              if (chunk.usageMetadata) usage = chunk.usageMetadata
              if (chunk.modelVersion) modelVersion = chunk.modelVersion
              blockReason ??= chunk.promptFeedback?.blockReason
              const candidate = chunk.candidates?.[0]
              if (candidate?.finishReason) finishReason = candidate.finishReason
              for (const part of candidate?.content?.parts ?? []) {
                if (part.thought) continue
                if (part.functionCall) {
                  const { id: geminiId, name, args } = part.functionCall
                  const valid =
                    typeof name === 'string' &&
                    name !== '' &&
                    (args === undefined ||
                      (typeof args === 'object' && args !== null && !Array.isArray(args)))
                  if (!valid) {
                    malformed = true
                    continue
                  }
                  const id = `toolu_gemini_${randomBytes(12).toString('hex')}`
                  const record: CallRecord = {}
                  if (typeof geminiId === 'string' && geminiId) record.geminiId = geminiId
                  if (part.thoughtSignature) record.signature = part.thoughtSignature
                  remember(id, record)
                  content.push({
                    type: 'tool_use',
                    id,
                    name,
                    input: args ?? {},
                    caller: { type: 'direct' },
                  })
                } else if (typeof part.text === 'string' && part.text) {
                  const last = content.at(-1)
                  if (last?.type === 'text') last.text += part.text
                  else content.push({ type: 'text', text: part.text, citations: null })
                  if (!controller.signal.aborted)
                    for (const listener of listeners) listener(part.text)
                }
              }
            }
          } catch (error) {
            if (idleState.stalled)
              throw new GeminiError('network', 'Gemini stopped responding. Try again.')
            if (controller.signal.aborted)
              throw new GeminiError('aborted', 'Gemini request cancelled.')
            if (error instanceof GeminiError) throw error
            throw new GeminiError('network', 'The connection to Gemini was interrupted. Try again.')
          } finally {
            clearTimeout(idle)
            signal.removeEventListener('abort', abort)
          }
          const hasCalls = content.some((block) => block.type === 'tool_use')
          if (malformed || finishReason === 'MALFORMED_FUNCTION_CALL')
            throw new GeminiError(
              'protocol',
              'Gemini produced a malformed tool call, so nothing was run. Try again.',
            )
          if (finishReason === 'MISSING_THOUGHT_SIGNATURE')
            throw new GeminiError(
              'protocol',
              'Gemini could not continue this tool conversation. Start a new conversation.',
            )
          if (!finishReason && !blockReason)
            throw new GeminiError('network', 'The Gemini response ended early. Try again.')
          return {
            id: `msg_gemini_${randomBytes(12).toString('hex')}`,
            type: 'message',
            role: 'assistant',
            model: modelVersion ?? model,
            content,
            stop_reason: blockReason ? 'refusal' : toStopReason(finishReason, hasCalls),
            stop_sequence: null,
            stop_details: null,
            container: null,
            diagnostics: null,
            usage: toUsage(usage),
          }
        }

        const final = run()
        // Callers may abort without ever awaiting the result.
        final.catch(() => {})
        return {
          on(_event, listener) {
            listeners.push(listener)
          },
          finalMessage: () => final,
          abort,
        }
      },
    },
  }
}
