import { app, dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron'
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/*
 * The main process's log file and its last line of defence: a renderer that crashes or hangs,
 * and errors nothing else caught. The hidden document reader window and the helper processes
 * have their own failure handling (documents/worker-host.ts) and are not watched here.
 */

const LOG_MAX_BYTES = 1024 * 1024
const LOG_MAX_FILES = 3
/** Longest text the patterns look at; what they cut short never survives RECORD_MAX_CHARS. */
const SCAN_MAX_CHARS = 64 * 1024
const STRING_MAX_CHARS = 2000
const RECORD_MAX_CHARS = 8000
const STACK_MAX_FRAMES = 20
/** How long a quit may take before a broken app is made to exit. */
const QUIT_DEADLINE_MS = 3000

const REDACTED = '[redacted]'

/** Message text that names a value: the secret or user content after the name goes. */
const NAMED_VALUE =
  /(api[_-]?key|x-goog-api-key|authorization|cookie|set-cookie|password|passwd|client[_-]?secret|secret|code[_-]?verifier|(?:access|refresh|id|auth|session)[_-]?(?:token|key)|token)(["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[^\s,;&}]+)/gi

/** A request or message body pasted into an error: JSON and util.inspect shapes. */
const CONTENT_FIELD =
  /(["']?)\b(prompt|messages|content|text|input|output|body|data|attachments?|system|file_?(?:data|contents?))\1(\s*:\s*)(?!\[redacted\])(?:"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[[{].*)/gi

const TEXT_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bdata:[\w.+-]+\/[\w.+-]+(?:;[\w=.-]+)*,[^\s"')]*/gi, `data:${REDACTED}`],
  [CONTENT_FIELD, `$1$2$1$3${REDACTED}`],
  [/\b(bearer|basic)\s+[\w.~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}(?:\.[\w-]*)?/g, REDACTED],
  [/\b(?:sk|sess|rk|pk)-[\w-]{6,}/g, REDACTED],
  [
    /\b(?:AIza[\w-]{16,}|ya29\.[\w.-]+|gh[pousr]_\w{10,}|github_pat_\w+|xox[a-z]-[\w-]+)/g,
    REDACTED,
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [NAMED_VALUE, `$1$2${REDACTED}`],
  // A sign-in's code and state, and anything else a query string or a user:pass@ carries.
  [/\b(https?:\/\/)[^\s/@"']+@/gi, `$1${REDACTED}@`],
  [/\b(https?:\/\/[^\s?#"')]+)[?#][^\s"')]*/gi, `$1?${REDACTED}`],
  // Encoded data (a key we do not know the shape of, an image, a file).
  [/[A-Za-z0-9+/_-]{64,}={0,2}/g, REDACTED],
]

/**
 * Removes what must never reach a log from free text: API keys, sign-in tokens, encoded data,
 * and bodies pasted into error messages. Also shortens the home folder, which names the user.
 */
export function redactText(text: string, home: string = homedir()): string {
  let out = text.length > SCAN_MAX_CHARS ? text.slice(0, SCAN_MAX_CHARS) : text
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement)
  return home.length > 1 ? out.replaceAll(home, '~') : out
}

const cap = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}...[${String(text.length - max)} more]` : text

/** Fields of a logged object that may hold secrets or user content: named, never shown. */
const SENSITIVE_KEY =
  /prompt|message|content|text|body|data|attachment|file|input|output|token|key|secret|pass|auth|cookie|code|image|base64|credential|header|session|request|response/i

function describeError(error: Error, depth: number): string {
  const code = (error as { code?: unknown }).code
  const label = typeof code === 'string' || typeof code === 'number' ? ` [${String(code)}]` : ''
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s*at /.test(line))
    .slice(0, STACK_MAX_FRAMES)
  const lines = [`${error.name}: ${cap(error.message, STRING_MAX_CHARS)}${label}`, ...frames]
  // Only this. SDK errors also carry the request, its headers and its body.
  if (error.cause instanceof Error && depth < 2) {
    lines.push(`Caused by: ${describeError(error.cause, depth + 1)}`)
  }
  return lines.join('\n')
}

function describeObject(value: object): string {
  if (Array.isArray(value)) return `[array of ${String(value.length)}]`
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary, ${String(value.byteLength)} bytes]`
  }
  const fields = Object.entries(value)
    .slice(0, 20)
    .map(([key, field]: [string, unknown]) => {
      if (SENSITIVE_KEY.test(key)) return `${key}: ${REDACTED}`
      if (typeof field === 'string') return `${key}: ${cap(field, 200)}`
      if (typeof field === 'number' || typeof field === 'boolean' || field == null) {
        return `${key}: ${String(field)}`
      }
      return `${key}: [${typeof field}]`
    })
  return `{ ${fields.join(', ')} }`
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return cap(value, STRING_MAX_CHARS)
  if (value instanceof Error) return describeError(value, 0)
  if (typeof value === 'object' && value !== null) return describeObject(value)
  if (typeof value === 'function') return '[function]'
  return String(value)
}

/** Turns console-style arguments into one safe piece of text. Never throws. */
export function formatLogArgs(args: readonly unknown[], home?: string): string {
  const parts = args.map((arg) => {
    try {
      return describeValue(arg)
    } catch {
      return '[unreadable]'
    }
  })
  return cap(redactText(parts.join(' '), home), RECORD_MAX_CHARS)
    .replaceAll('\r', '')
    .replaceAll(/\n\s*/g, '\n    ')
    .replaceAll(/[\p{Cc}]/gu, (char) => (char === '\n' ? char : ' '))
}

export interface RotatingLogOptions {
  dir: string
  name?: string
  maxBytes?: number
  /** How many files in all: main.log, main.1.log, main.2.log. */
  maxFiles?: number
}

/**
 * A size-capped log: main.log fills up, then moves to main.1.log, and the oldest goes. Written
 * synchronously so the last lines before a crash are on disk. A failure never reaches the
 * caller, and when the file cannot be rotated lines are dropped rather than growing past the cap.
 */
export class RotatingLogFile {
  private readonly dir: string
  private readonly name: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private size: number | null = null

  constructor(options: RotatingLogOptions) {
    this.dir = options.dir
    this.name = options.name ?? 'main'
    this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES
    this.maxFiles = options.maxFiles ?? LOG_MAX_FILES
  }

  private file(index: number): string {
    return join(this.dir, index === 0 ? `${this.name}.log` : `${this.name}.${String(index)}.log`)
  }

  private currentSize(): number {
    if (this.size !== null) return this.size
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try {
      return statSync(this.file(0)).size
    } catch {
      writeFileSync(this.file(0), '', { mode: 0o600 })
      return 0
    }
  }

  private rotate(): void {
    rmSync(this.file(this.maxFiles - 1), { force: true })
    for (let index = this.maxFiles - 2; index >= 0; index -= 1) {
      try {
        renameSync(this.file(index), this.file(index + 1))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  write(line: string): void {
    try {
      let bytes = Buffer.from(line, 'utf8')
      if (bytes.length > this.maxBytes) bytes = bytes.subarray(0, this.maxBytes)
      let size = this.currentSize()
      if (size + bytes.length > this.maxBytes) {
        try {
          this.rotate()
        } catch {
          // Windows: something holds the file open. Start it again rather than exceed the cap.
          truncateSync(this.file(0))
        }
        size = 0
      }
      appendFileSync(this.file(0), bytes, { mode: 0o600 })
      this.size = size + bytes.length
    } catch {
      // Nothing to report it to: logging never fails the app. The size is read again next time.
      this.size = null
    }
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  log(level: LogLevel, ...args: readonly unknown[]): void
}

export function createLogger(
  file: Pick<RotatingLogFile, 'write'>,
  options: {
    now?: () => Date
    home?: string
    mirror?: (level: LogLevel, text: string) => void
  } = {},
): Logger {
  const now = options.now ?? (() => new Date())
  return {
    log(level, ...args) {
      const text = formatLogArgs(args, options.home)
      file.write(`${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`)
      options.mirror?.(level, text)
    },
  }
}

const CONSOLE_LEVELS = [
  ['debug', 'debug'],
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
] as const

/**
 * Sends every console call in main through the logger, so no call site, in this code or a
 * library, can write around the redaction. Returns the way back, for tests.
 */
export function routeConsole(logger: Logger, target: Console = console): () => void {
  const restore = CONSOLE_LEVELS.map(([method, level]) => {
    const original = Object.getOwnPropertyDescriptor(target, method)
    target[method] = (...args: unknown[]) => {
      logger.log(level, ...args)
    }
    return () => {
      if (original) Object.defineProperty(target, method, original)
    }
  })
  return () => {
    for (const undo of restore) undo()
  }
}

/** Limits reloads of a renderer that keeps failing: past the limit only quitting is offered. */
export class CrashLoopGuard {
  private failures: number[] = []
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? 3
    this.windowMs = options.windowMs ?? 5 * 60_000
    this.now = options.now ?? Date.now
  }

  record(): void {
    this.failures.push(this.now())
  }

  canReload(): boolean {
    const since = this.now() - this.windowMs
    this.failures = this.failures.filter((at) => at > since)
    return this.failures.length < this.limit
  }
}

export type RecoveryKind = 'crashed' | 'unresponsive'
export type RecoveryChoice = 'reload' | 'quit' | 'wait' | 'open-logs-and-quit'

export interface RecoveryPrompt {
  message: string
  detail: string
  choices: readonly RecoveryChoice[]
  buttons: readonly string[]
  /** Enter. */
  defaultId: number
  /** Esc or closing the box: it must never leave a dead window with nothing offered. */
  cancelId: number
}

const CHOICE_LABELS: Record<RecoveryChoice, string> = {
  reload: 'Reload',
  quit: 'Quit',
  wait: 'Keep waiting',
  'open-logs-and-quit': 'Open logs folder and quit',
}

function prompt(
  message: string,
  detail: string,
  choices: readonly RecoveryChoice[],
  cancel: RecoveryChoice,
): RecoveryPrompt {
  return {
    message,
    detail,
    choices,
    buttons: choices.map((choice) => CHOICE_LABELS[choice]),
    defaultId: 0,
    cancelId: choices.indexOf(cancel),
  }
}

export function recoveryPrompt(kind: RecoveryKind, canReload: boolean): RecoveryPrompt {
  const stopped = 'Any reply in progress was stopped and pending approvals were denied.'
  const willStop = 'Reloading stops any reply in progress and denies pending approvals.'
  if (kind === 'unresponsive') {
    return canReload
      ? prompt(
          'The Desktop Agent window is not responding.',
          `It may recover if you wait. ${willStop}`,
          ['wait', 'reload', 'quit'],
          'wait',
        )
      : prompt(
          'The Desktop Agent window is not responding.',
          'It has failed several times in the last few minutes, so reloading is no longer offered.',
          ['wait', 'quit'],
          'wait',
        )
  }
  return canReload
    ? prompt(
        'The Desktop Agent window crashed.',
        `${stopped} Reload to carry on, or quit.`,
        ['reload', 'quit'],
        'reload',
      )
    : prompt(
        'The Desktop Agent window keeps crashing.',
        `${stopped} It has failed several times in the last few minutes, so reloading is unlikely to help.`,
        ['quit', 'open-logs-and-quit'],
        'quit',
      )
}

type WatchedContents = Pick<
  BrowserWindow['webContents'],
  'reload' | 'forcefullyCrashRenderer' | 'isDestroyed'
> & {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: GoneDetails) => void,
  ): unknown
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown
  on(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown
}
interface GoneDetails {
  reason: string
  exitCode: number
}
export type WatchedWindow = Pick<BrowserWindow, 'isDestroyed'> & { webContents: WatchedContents }

export interface RecoveryDeps {
  logger: Logger
  guard: CrashLoopGuard
  show: (window: WatchedWindow, prompt: RecoveryPrompt, signal: AbortSignal) => Promise<number>
  quit: () => void
  openLogs: () => void
  isQuitting: () => boolean
}

/**
 * Offers Reload or Quit when the app window's renderer dies or hangs. The run and its approvals
 * are not handled here: chat/lifecycle.ts cancels them when the page goes, and they stay denied.
 */
export function watchRenderer(window: WatchedWindow, deps: RecoveryDeps): void {
  const { logger, guard } = deps
  const contents = window.webContents
  let showing: { kind: RecoveryKind; controller: AbortController } | null = null
  // The hung renderer this code killed in order to reload it: its exit is no crash to report.
  let killedForReload = false

  const act = (choice: RecoveryChoice | undefined, kind: RecoveryKind): void => {
    logger.log('info', `recovery (${kind}): ${choice ?? 'dismissed'}`)
    if (choice === 'quit') deps.quit()
    if (choice === 'open-logs-and-quit') {
      deps.openLogs()
      deps.quit()
    }
    if (choice !== 'reload' || window.isDestroyed() || contents.isDestroyed()) return
    if (kind === 'crashed') {
      contents.reload()
      return
    }
    // A reload sent while the process is dying gets lost: it follows the exit, below.
    guard.record()
    killedForReload = true
    contents.forcefullyCrashRenderer()
  }

  const ask = async (kind: RecoveryKind): Promise<void> => {
    const plan = recoveryPrompt(kind, guard.canReload())
    const controller = new AbortController()
    showing = { kind, controller }
    let answer = plan.cancelId
    try {
      answer = await deps.show(window, plan, controller.signal)
    } catch (error) {
      logger.log('error', 'could not show the recovery prompt', error)
    }
    if (controller.signal.aborted) return
    showing = null
    act(plan.choices[answer], kind)
  }

  contents.on('render-process-gone', (_event, details) => {
    logger.log('error', `renderer gone: ${details.reason} (exit code ${String(details.exitCode)})`)
    if (deps.isQuitting() || window.isDestroyed()) return
    if (killedForReload) {
      killedForReload = false
      contents.reload()
      return
    }
    showing?.controller.abort()
    guard.record()
    void ask('crashed')
  })
  contents.on('unresponsive', () => {
    logger.log('warn', 'renderer unresponsive')
    if (showing || deps.isQuitting() || window.isDestroyed()) return
    void ask('unresponsive')
  })
  contents.on('responsive', () => {
    logger.log('info', 'renderer responsive again')
    if (showing?.kind !== 'unresponsive') return
    showing.controller.abort()
    showing = null
  })
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) logger.log('error', `page failed to load: ${String(code)} ${description}`)
  })
}

export interface FatalDeps {
  logger: Logger
  /** The app window exists: startup finished, so one failed task need not end the app. */
  isStarted: () => boolean
  logsPath: string
  showError: (title: string, content: string) => void
  quit: () => void
}

/**
 * What errors nothing caught do. An uncaught exception leaves main in an unknown state, so the
 * app says so and closes. A rejection is one failed task and is logged, unless it came before
 * there was a window: that is how a failed startup looks, and the app would sit there unseen.
 */
export function fatalHandlers(deps: FatalDeps): {
  uncaughtException: (error: unknown) => void
  unhandledRejection: (reason: unknown) => void
} {
  let closing = false
  const close = (what: string, error: unknown): void => {
    deps.logger.log('error', `fatal: ${what}:`, error)
    if (closing) return
    closing = true
    try {
      deps.showError(
        'Desktop Agent has to close',
        `Something unexpected went wrong. Details are in the logs folder:\n${deps.logsPath}`,
      )
    } catch (failure) {
      deps.logger.log('error', 'could not show the error dialog', failure)
    }
    deps.quit()
  }
  return {
    uncaughtException: (error) => {
      close('uncaught exception', error)
    },
    unhandledRejection: (reason) => {
      if (deps.isStarted()) deps.logger.log('error', 'unhandled rejection:', reason)
      else close('startup failed', reason)
    },
  }
}

/** The folder the logs live in. Fixed: nothing may ask to open another one. */
export function logsFolder(): string {
  return join(app.getPath('userData'), 'logs')
}

export interface Diagnostics {
  logger: Logger
  openLogsFolder: () => void
  /** Call with the app window: not the hidden document reader, which handles its own failures. */
  watchWindow: (window: BrowserWindow) => void
}

/** Starts the log file, routes console to it and installs the handlers of last resort. */
export function installDiagnostics(): Diagnostics {
  // In dev the terminal still shows what the log gets. Packaged, there is no terminal to show it.
  const original = { ...console }
  const logger = createLogger(new RotatingLogFile({ dir: logsFolder() }), {
    ...(app.isPackaged
      ? {}
      : {
          mirror: (level: LogLevel, text: string) => {
            original[level](text)
          },
        }),
  })
  routeConsole(logger)
  logger.log(
    'info',
    `Desktop Agent ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`,
  )

  let quitting = false
  app.on('before-quit', () => {
    quitting = true
  })
  // Before-quit handlers still stop the run and deny approvals, if main can get that far.
  const quitWithin = (deadlineMs: number, exitCode: number): void => {
    app.quit()
    setTimeout(() => {
      app.exit(exitCode)
    }, deadlineMs)
  }
  const openLogsFolder = (): void => {
    const folder = logsFolder()
    try {
      mkdirSync(folder, { recursive: true })
    } catch (error) {
      logger.log('warn', 'could not create the logs folder', error)
    }
    void shell.openPath(folder).then((failure) => {
      if (failure) logger.log('warn', `could not open the logs folder: ${failure}`)
    })
  }

  let started = false
  const fatal = fatalHandlers({
    logger,
    isStarted: () => started,
    logsPath: logsFolder(),
    showError: (title, content) => {
      dialog.showErrorBox(title, content)
    },
    quit: () => {
      quitWithin(QUIT_DEADLINE_MS, 1)
    },
  })
  process.on('uncaughtException', fatal.uncaughtException)
  process.on('unhandledRejection', fatal.unhandledRejection)
  app.on('child-process-gone', (_event, details) => {
    logger.log('warn', `${details.type} process gone: ${details.reason}`)
  })

  const guard = new CrashLoopGuard()
  return {
    logger,
    openLogsFolder,
    watchWindow(window) {
      started = true
      watchRenderer(window, {
        logger,
        guard,
        show: async (target, plan, signal) => {
          const options: MessageBoxOptions = {
            type: 'warning',
            title: 'Desktop Agent',
            message: plan.message,
            detail: plan.detail,
            buttons: [...plan.buttons],
            defaultId: plan.defaultId,
            cancelId: plan.cancelId,
            noLink: true,
            signal,
          }
          const { response } = target.isDestroyed()
            ? await dialog.showMessageBox(options)
            : await dialog.showMessageBox(target as BrowserWindow, options)
          return response
        },
        quit: () => {
          quitWithin(QUIT_DEADLINE_MS, 0)
        },
        openLogs: openLogsFolder,
        isQuitting: () => quitting,
      })
    },
  }
}
