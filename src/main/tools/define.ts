import type { AuditApproval, AuditSink } from '../permissions/audit'
import type { PathGuard, ResolveOptions } from '../permissions/guard'
import type { AgentTool, ApprovalRequest, JsonSchema, ToolContext, ToolResult } from './types'

/** Thrown by input parsers; becomes an `Invalid input: ...` error result. */
export class ToolInputError extends Error {}

/**
 * Short, content-free categories for failed calls. The audit log records
 * these, never the error message (which can quote paths or patterns).
 * Unexpected errors are logged by their Node error code (EACCES, ...).
 */
export type ErrorCode =
  | 'invalid-input'
  | 'access-denied'
  | 'declined'
  | 'cancelled'
  | 'not-found'
  | 'not-a-file'
  | 'not-a-folder'
  | 'exists'
  | 'too-large'
  | 'binary'
  | 'hard-link'
  | 'changed'
  | 'protected'
  | 'timeout'
  | 'kill-failed'
  | 'spawn-failed'
  | 'unsupported'
  | 'unreadable'
  | 'out-of-range'
  | 'worker-failed'
  | 'busy'
  | 'failed'

/** Thrown by tool bodies for expected failures; becomes an error result with this message. */
export class ToolFailure extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = 'failed',
  ) {
    super(message)
  }
}

/**
 * Facts a tool learns while running, recorded under the audit entry's `args.extra`.
 * Only these keys, each a small scalar, are kept; anything else is dropped, so a tool
 * can neither overwrite its summarized args nor put file contents in the log.
 */
export interface AuditExtras {
  /** The detected file type, a short lowercase tag such as 'pdf'. */
  kind?: string
  imageCount?: number
  locationRead?: boolean
  /** search_files: documents whose text was searched (read now or from the cache). */
  documentsSearched?: number
  documentsFromCache?: number
  /** search_files: documents found but not searched (limits, scanned, unreadable, secret). */
  documentsNotSearched?: number
}

const count = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000

const AUDIT_EXTRAS: Record<keyof AuditExtras, (value: unknown) => boolean> = {
  kind: (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,15}$/.test(value),
  imageCount: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000,
  locationRead: (value) => typeof value === 'boolean',
  documentsSearched: count,
  documentsFromCache: count,
  documentsNotSearched: count,
}

/** The allowlisted, well-formed fields of a tool's audit extras, or undefined if none. */
export function auditExtras(raw: unknown): AuditExtras | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const kept: Record<string, unknown> = {}
  for (const [key, valid] of Object.entries(AUDIT_EXTRAS)) {
    if (!Object.hasOwn(raw, key)) continue
    const value = (raw as Record<string, unknown>)[key]
    if (valid(value)) kept[key] = value
  }
  return Object.keys(kept).length ? kept : undefined
}

/** A tool body's result: a ToolResult plus, for errors, the category to audit. */
export interface RunResult extends ToolResult {
  code?: ErrorCode
  /** Facts learned while running; see AuditExtras. */
  audit?: AuditExtras
}

export function errorResult(message: string, code: ErrorCode): RunResult {
  return { content: message, isError: true, code }
}

function errnoCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'internal'
}

/** The per-call handle a tool body works with. */
export interface ToolCall {
  readonly ctx: ToolContext
  /**
   * Resolves a path through the guard and records it for the audit log.
   * Throws ToolFailure when the path is not allowed.
   */
  resolve(input: string, options?: ResolveOptions): Promise<{ path: string; exists: boolean }>
  /** Records an extra path for the audit log. */
  notePath(path: string): void
  /**
   * Asks the user. Returns true only if they approved and the call has not
   * been cancelled since; a thrown or rejected request counts as a refusal.
   */
  approve(request: Omit<ApprovalRequest, 'tool'>): Promise<boolean>
  /** Throws ToolFailure if the call has been cancelled. */
  throwIfAborted(): void
}

export interface ToolSpec<I> {
  name: string
  description: string
  inputSchema: JsonSchema
  /** Whether the tool asks for approval (for the audit log's approval field). */
  needsApproval: boolean
  parse(input: InputReader): I
  /**
   * What goes into the audit log for these arguments. Never file contents.
   * `approval` lets a tool log more for calls the user actually approved.
   */
  summarize(input: I, approval: AuditApproval): Record<string, unknown>
  run(input: I, call: ToolCall): Promise<RunResult>
}

export interface WrapDeps {
  guard: PathGuard
  audit: AuditSink
  now: () => number
  /** Called when the audit sink throws or rejects; the call still returns its result. */
  onAuditFailure: (error: unknown) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Turns a ToolSpec into an AgentTool: validates input, never throws (every
 * failure becomes an `isError` result), and writes one audit entry per call.
 */
export function defineTool<I>(spec: ToolSpec<I>, deps: WrapDeps): AgentTool<unknown> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
      const started = deps.now()
      const paths: string[] = []
      let approval: AuditApproval = spec.needsApproval ? 'not-requested' : 'auto'
      let input: I | undefined

      const call: ToolCall = {
        ctx,
        async resolve(path, options) {
          const resolution = await deps.guard.resolve(path, options)
          if (!resolution.ok) {
            paths.push(path)
            throw new ToolFailure(`Access denied: ${resolution.reason}`, 'access-denied')
          }
          paths.push(resolution.path)
          return { path: resolution.path, exists: resolution.exists }
        },
        notePath(path) {
          paths.push(path)
        },
        async approve(request) {
          if (ctx.signal.aborted) return false
          let approved: boolean
          try {
            approved = await ctx.requestApproval({ tool: spec.name, ...request })
          } catch {
            approved = false
          }
          approval = approved ? 'approved' : 'denied'
          return approved && !ctx.signal.aborted
        },
        throwIfAborted() {
          if (ctx.signal.aborted) throw new ToolFailure('Cancelled.', 'cancelled')
        },
      }

      let result: RunResult
      let errorCode: string | undefined
      try {
        input = spec.parse(new InputReader(raw, spec.inputSchema))
        call.throwIfAborted()
        result = await spec.run(input, call)
        errorCode = result.isError ? (result.code ?? 'failed') : undefined
      } catch (error) {
        if (error instanceof ToolInputError) {
          result = errorResult(`Invalid input: ${error.message}`, 'invalid-input')
          errorCode = 'invalid-input'
        } else if (error instanceof ToolFailure) {
          result = errorResult(error.message, error.code)
          errorCode = error.code
        } else {
          result = errorResult(`${spec.name} failed: ${messageOf(error)}`, 'failed')
          errorCode = errnoCode(error)
        }
      }

      try {
        const extra = auditExtras(result.audit)
        await deps.audit.record({
          tool: spec.name,
          args:
            input === undefined
              ? { invalidInput: true }
              : { ...spec.summarize(input, approval), ...(extra ? { extra } : {}) },
          paths,
          approval,
          origin: ctx.origin ?? 'agent',
          outcome: result.isError ? 'error' : 'ok',
          ...(errorCode === undefined ? {} : { error: errorCode }),
          durationMs: Math.max(0, Math.round(deps.now() - started)),
        })
      } catch (error) {
        try {
          deps.onAuditFailure(error)
        } catch {
          // Reporting the failure failed too; the call's result still stands.
        }
      }
      if (!result.isError)
        return result.images?.length
          ? { content: result.content, images: result.images }
          : { content: result.content }
      return errorCode === 'declined'
        ? { content: result.content, isError: true, declined: true }
        : { content: result.content, isError: true }
    },
  }
}

/** Reads typed fields from raw tool input, enforcing the schema's required and unknown keys. */
export class InputReader {
  private readonly obj: Record<string, unknown>

  constructor(raw: unknown, schema: JsonSchema) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ToolInputError('expected an object.')
    }
    this.obj = raw as Record<string, unknown>
    for (const key of Object.keys(this.obj)) {
      if (!(key in schema.properties)) throw new ToolInputError(`unknown property "${key}".`)
    }
    for (const key of schema.required ?? []) {
      if (this.obj[key] === undefined) throw new ToolInputError(`"${key}" is required.`)
    }
  }

  string(key: string): string {
    const value = this.optionalString(key)
    if (value === undefined) throw new ToolInputError(`"${key}" is required.`)
    return value
  }

  optionalString(key: string): string | undefined {
    const value = this.obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string.`)
    return value
  }

  optionalInteger(key: string, min: number, max: number): number | undefined {
    const value = this.obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new ToolInputError(`"${key}" must be an integer from ${String(min)} to ${String(max)}.`)
    }
    return value
  }

  optionalObject(key: string): Record<string, unknown> | undefined {
    const value = this.obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ToolInputError(`"${key}" must be an object.`)
    }
    return value as Record<string, unknown>
  }

  optionalBoolean(key: string): boolean | undefined {
    const value = this.obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new ToolInputError(`"${key}" must be true or false.`)
    return value
  }
}
