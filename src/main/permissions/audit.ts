import { promises as fs } from 'node:fs'
import path from 'node:path'

/** How a tool call got permission: no approval needed, the user's answer, or never asked. */
export type AuditApproval = 'auto' | 'approved' | 'denied' | 'not-requested'

export interface AuditEntry {
  /** ISO 8601 timestamp. */
  ts: string
  tool: string
  /** A summary of the arguments: paths, sizes, flags. Never file contents. */
  args: Record<string, unknown>
  /** The resolved paths the call touched or was refused. */
  paths: string[]
  approval: AuditApproval
  outcome: 'ok' | 'error'
  /** First line of the error message, for failed calls. */
  error?: string
  durationMs: number
}

export interface AuditSink {
  record(entry: Omit<AuditEntry, 'ts'>): Promise<void>
}

// Common token shapes and `key=value` secrets. Best effort: audit entries
// carry no file contents, but shell commands and search patterns are logged.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]
const SECRET_ASSIGNMENT =
  /(?<![A-Za-z0-9])(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|auth)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi

/** Masks things that look like credentials in free text bound for the audit log. */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out.replace(
    SECRET_ASSIGNMENT,
    (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`,
  )
}

export interface AuditLogOptions {
  /** Called when an entry cannot be written. Tool calls still complete. */
  onError?: (error: unknown) => void
}

/**
 * Append-only JSONL audit log: one entry per tool call. Writes are serialized
 * so lines never interleave.
 */
export class AuditLog implements AuditSink {
  private queue: Promise<void> = Promise.resolve()
  private readonly onError: (error: unknown) => void

  constructor(
    readonly file: string,
    options: AuditLogOptions = {},
  ) {
    this.onError =
      options.onError ??
      ((error) => {
        console.error('audit log write failed', error)
      })
  }

  record(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
    this.queue = this.queue.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        await fs.appendFile(this.file, line, { encoding: 'utf8', flag: 'a' })
      } catch (error) {
        this.onError(error)
      }
    })
    return this.queue
  }
}
