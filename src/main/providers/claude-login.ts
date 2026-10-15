import type { RuntimeContext } from './codex'
import { killRuntime, launch } from './runtime'

/** Pinned 2.1.299 prints the fallback link on this line; everything after the colon is the URL. */
const URL_PREFIX = "If the browser didn't open, visit:"
/** Exact hosts only: no subdomains, so a lookalike such as claude.ai.example.com never matches. */
export const CLAUDE_LOGIN_HOSTS: readonly string[] = [
  'claude.com',
  'claude.ai',
  'platform.claude.com',
]
/** The code the browser shows after authorizing: `<code>#<state>`. */
export const LOGIN_CODE_PATTERN = /^[^#\s]+#[^#\s]+$/
export const CLAUDE_LOGIN_TIMEOUT = 5 * 60 * 1000
const STDERR_TAIL = 2048

/** Removes CSI sequences and OSC sequences (including OSC 8 hyperlinks) from terminal output. */
export function stripEscapes(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-_]?/g, '')
  )
}

/** Plain, single-spaced, printable text for showing runtime output in Settings. */
export function sanitizeOutput(text: string): string {
  return (
    stripEscapes(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** The raw link on a fallback line, or undefined for any other line. */
export function extractLoginUrl(line: string): string | undefined {
  const text = stripEscapes(line).trim()
  if (!text.startsWith(URL_PREFIX)) return undefined
  const raw = text
    .slice(URL_PREFIX.length)
    .trim()
    .replace(/^<(.*)>$/, '$1')
  return raw || undefined
}

/** The normalized link when it is an https Claude sign-in page, otherwise undefined. */
export function validateLoginUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'https:' ||
    !CLAUDE_LOGIN_HOSTS.includes(url.hostname) ||
    url.port !== '' ||
    url.username ||
    url.password
  )
    return undefined
  return url.href
}

export interface ClaudeLoginOptions {
  signal: AbortSignal
  openUrl: (url: string) => Promise<void>
  /** Called once with the validated link so Settings can show it. */
  onUrl: (url: string) => void
  timeout?: number
}

/**
 * One `claude auth login` run. The runtime prints the sign-in link and then waits for either
 * its localhost callback or a pasted code on stdin; the app opens the link itself because the
 * runtime's own browser launch can fail silently on Windows.
 */
export class ClaudeLogin {
  /** The validated link, once the runtime has printed it. */
  url: string | undefined
  readonly done: Promise<void>
  private readonly child

  constructor(context: RuntimeContext, options: ClaudeLoginOptions) {
    options.signal.throwIfAborted()
    const child = launch(context.file, ['auth', 'login'], context.cwd, context.env)
    this.child = child
    let stderr = ''
    const failure = (message: string) => {
      const detail = sanitizeOutput(stderr)
      return new Error(detail ? `${message} ${detail}` : message)
    }
    this.done = new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
        // Resolve only once the runtime is gone, so a cancelled sign-in leaves nothing running.
        void killRuntime(child)
          .catch(() => {})
          .then(() => {
            if (error) reject(error)
            else resolve()
          })
      }
      const abort = () => {
        finish(new Error('Sign-in cancelled.'))
      }
      const timer = setTimeout(() => {
        finish(failure('Sign-in timed out. Try again.'))
      }, options.timeout ?? CLAUDE_LOGIN_TIMEOUT)
      options.signal.addEventListener('abort', abort, { once: true })

      let pending = ''
      const line = (text: string) => {
        if (this.url !== undefined) return
        const raw = extractLoginUrl(text)
        if (raw === undefined) return
        const url = validateLoginUrl(raw)
        if (!url) {
          finish(new Error('Claude returned an unexpected sign-in link, so it was not opened.'))
          return
        }
        this.url = url
        options.onUrl(url)
        // The link stays visible in Settings if the browser cannot be opened.
        options.openUrl(url).catch(() => {})
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split(/\r?\n|\r/)
        pending = lines.pop() ?? ''
        for (const text of lines) line(text)
        if (pending.length > 64 * 1024) pending = ''
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL)
      })
      // A write after exit fails with EPIPE; the exit itself reports the outcome.
      child.stdin.on('error', () => {})
      child.once('error', () => {
        finish(new Error('Claude sign-in could not start.'))
      })
      child.once('close', (code) => {
        finish(
          code === 0
            ? undefined
            : failure(`Claude sign-in failed (exit code ${String(code ?? 'unknown')}).`),
        )
      })
    })
    void this.done.catch(() => {})
  }

  /** Sends the code shown in the browser to the waiting runtime. */
  submitCode(code: unknown): { ok: true } | { ok: false; error: string } {
    if (typeof code !== 'string' || code.length > 4096 || !LOGIN_CODE_PATTERN.test(code.trim()))
      return { ok: false, error: 'That does not look like a sign-in code. Copy the whole code.' }
    if (!this.child.stdin.writable)
      return { ok: false, error: 'Sign-in is no longer waiting for a code.' }
    this.child.stdin.write(code.trim() + '\n')
    return { ok: true }
  }
}
