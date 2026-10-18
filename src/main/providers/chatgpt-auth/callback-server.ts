import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CALLBACK_PATH } from './config'
import { ChatgptAuthError } from './errors'

/** The page the browser shows after the redirect. Static: nothing from the request is echoed. */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Desktop Agent</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem">
<h1>You can close this tab</h1>
<p>Return to Desktop Agent to finish signing in with ChatGPT.</p>
</body></html>
`
const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  connection: 'close',
}

export interface CallbackListener {
  /** http://127.0.0.1:<port>/auth/callback, exactly as sent with the request and the exchange. */
  redirectUri: string
  /** The callback's query parameters: settles once, on the first GET to the callback path. */
  result: Promise<URLSearchParams>
  /** Stops listening and drops every connection. Safe to call more than once. */
  close: () => Promise<void>
}

/**
 * The loopback listener for one sign-in attempt, bound to 127.0.0.1 on an
 * ephemeral port. Accepts only GET /auth/callback addressed to that exact host
 * and port (so a rebound DNS name cannot reach it), takes one result, and closes
 * on that result, on timeout or on abort.
 */
const isAborted = (signal: AbortSignal): boolean => signal.aborted

export async function startCallbackListener({
  signal,
  timeout,
}: {
  signal: AbortSignal
  timeout: number
}): Promise<CallbackListener> {
  if (signal.aborted) throw new ChatgptAuthError('cancelled')
  let settle: { resolve: (value: URLSearchParams) => void; reject: (error: Error) => void }
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    settle = { resolve, reject }
  })
  void result.catch(() => {})
  let settled = false
  let host = ''

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, body: string, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { ...HEADERS, 'content-type': type })
      response.end(body)
    }
    if (request.headers.host !== host) {
      reply(400, 'Bad request.')
      return
    }
    // The path is compared before parsing, so no normalisation can make another path match.
    const target = request.url ?? ''
    const query = target.indexOf('?')
    const path = query === -1 ? target : target.slice(0, query)
    if (path !== CALLBACK_PATH) {
      reply(404, 'Not found.')
      return
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET')
      reply(405, 'Method not allowed.')
      return
    }
    if (settled) {
      reply(410, 'This sign-in has already finished.')
      return
    }
    reply(200, PAGE, 'text/html; charset=utf-8')
    finish(undefined, new URLSearchParams(query === -1 ? '' : target.slice(query + 1)))
  })
  server.on('clientError', (_error, socket) => {
    socket.destroy()
  })

  let closed: Promise<void> | undefined
  const close = (): Promise<void> => {
    closed ??= new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
      // Let a reply that is being written finish, then drop whatever is left.
      setImmediate(() => {
        server.closeAllConnections()
      })
    })
    return closed
  }
  const finish = (error: Error | undefined, params?: URLSearchParams) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    if (error) settle.reject(error)
    else if (params) settle.resolve(params)
    void close()
  }
  const abort = () => {
    finish(new ChatgptAuthError('cancelled'))
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch {
    settled = true
    await close()
    throw new ChatgptAuthError('listener')
  }
  // Checked again: the signal may have been aborted while the port was being bound.
  if (isAborted(signal)) {
    settled = true
    await close()
    throw new ChatgptAuthError('cancelled')
  }
  const timer = setTimeout(() => {
    finish(new ChatgptAuthError('timed-out'))
  }, timeout)
  signal.addEventListener('abort', abort, { once: true })
  const { port } = server.address() as AddressInfo
  host = `127.0.0.1:${String(port)}`
  return { redirectUri: `http://${host}${CALLBACK_PATH}`, result, close }
}
