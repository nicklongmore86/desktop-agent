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

/** A tool body's result: a ToolResult plus, for errors, the category to audit. */
export interface RunResult extends ToolResult {
  code?: ErrorCode
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
  /** What goes into the audit log for these arguments. Never file contents. */
  summarize(input: I): Record<string, unknown>
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
        await deps.audit.record({
          tool: spec.name,
          args: input === undefined ? { invalidInput: true } : spec.summarize(input),
          paths,
          approval,
          outcome: result.isError ? 'error' : 'ok',
          ...(errorCode === undefined ? {} : { error: errorCode }),
          durationMs: Math.max(0, Math.round(deps.now() - started)),
        })
      } catch (error) {
        deps.onAuditFailure(error)
      }
      return result.isError
        ? { content: result.content, isError: true }
        : { content: result.content }
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

  optionalBoolean(key: string): boolean | undefined {
    const value = this.obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new ToolInputError(`"${key}" must be true or false.`)
    return value
  }
}
