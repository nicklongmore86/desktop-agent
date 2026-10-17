// A local fake Chat Completions server for the openai-compat tests. Not imported by app code.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: unknown
}
export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>

export interface FakeServer {
  /** http://127.0.0.1:<port>/v1 */
  baseUrl: string
  origin: string
  requests: Recorded[]
  /** Handlers answer requests in order; the last one repeats. */
  reply(...handlers: Handler[]): void
  close(): Promise<void>
}

export async function fakeServer(): Promise<FakeServer> {
  const requests: Recorded[] = []
  let handlers: Handler[] = []
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const recorded: Recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      }
      requests.push(recorded)
      const handler = handlers.length > 1 ? handlers.shift() : handlers[0]
      if (!handler) {
        res.writeHead(500).end()
        return
      }
      Promise.resolve(handler(recorded, res)).catch(() => res.destroy())
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${String(port)}`
  return {
    baseUrl: `${origin}/v1`,
    origin,
    requests,
    reply(...next) {
      handlers = next
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          resolve()
        })
      }),
  }
}

export const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
  extra: Record<string, unknown> = {},
) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
})
export const usageChunk = (prompt = 12, completion = 5, cached = 0) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [],
  usage: {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  },
})
export const toolDelta = (
  index: number,
  fields: { id?: string; name?: string; args?: string },
) => ({
  tool_calls: [
    {
      index,
      ...(fields.id ? { id: fields.id, type: 'function' } : {}),
      function: {
        ...(fields.name ? { name: fields.name } : {}),
        ...(fields.args !== undefined ? { arguments: fields.args } : {}),
      },
    },
  ],
})

/** Streams each event as an SSE `data:` line, then `[DONE]`. */
export function sse(events: unknown[], { done = true } = {}): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    // A comment line, as OpenRouter sends while processing.
    res.write(': keep-alive\n\n')
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    if (done) res.write('data: [DONE]\n\n')
    res.end()
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
}

/** Rewrites every URL onto the fake server, keeping the path: tests hosted flavors locally. */
export function redirectFetch(origin: string, seen: string[] = []) {
  return (input: string, init: RequestInit): Promise<Response> => {
    seen.push(input)
    const url = new URL(input)
    return fetch(`${origin}${url.pathname}`, init)
  }
}
