import type { AuditSink } from '../permissions/audit'
import type { PathGuard } from '../permissions/guard'
import type { KillTree, ShellSpawner } from './run-shell'

export interface ToolLimits {
  /** read_file refuses bigger files unless a line range is given. Also the cap on returned text. */
  maxReadBytes: number
  /** write_file refuses bigger content. */
  maxWriteBytes: number
  maxListEntries: number
  maxListDepth: number
  defaultSearchResults: number
  maxSearchResults: number
  maxSearchDepth: number
  /** search_files stops after visiting this many entries. */
  maxSearchEntries: number
  /** search_files stops after this long. */
  searchTimeMs: number
  /** move/delete of a folder scans it for blocked entries; bigger folders are refused. */
  maxScanEntries: number
  /** write_file refuses changes whose diff is bigger: the user must see the whole preview. */
  maxDiffBytes: number
  defaultShellTimeoutMs: number
  maxShellTimeoutMs: number
  /** Per stream (stdout, stderr); the middle of longer output is dropped. */
  maxShellOutputBytes: number
  /** After killing a shell, how long to wait for it to exit before reporting it may still run. */
  killGraceMs: number
}

export const DEFAULT_LIMITS: ToolLimits = {
  maxReadBytes: 1024 * 1024,
  maxWriteBytes: 5 * 1024 * 1024,
  maxListEntries: 1000,
  maxListDepth: 5,
  defaultSearchResults: 100,
  maxSearchResults: 1000,
  maxSearchDepth: 20,
  maxSearchEntries: 50_000,
  searchTimeMs: 10_000,
  maxScanEntries: 100_000,
  maxDiffBytes: 256 * 1024,
  defaultShellTimeoutMs: 60_000,
  maxShellTimeoutMs: 10 * 60_000,
  maxShellOutputBytes: 100_000,
  killGraceMs: 5000,
}

export interface ToolDeps {
  /** Decides which paths tools may touch. Build it from the GrantStore's roots. */
  guard: PathGuard
  /** Where every call is recorded. */
  audit: AuditSink
  /** Moves a path to the Recycle Bin / Trash. At wiring time: Electron's shell.trashItem. */
  trash: (path: string) => Promise<void>
  /** Starts the shell process. Defaults to child_process.spawn. */
  spawn?: ShellSpawner
  /** Kills a shell process and its children. Defaults to taskkill /T on Windows, a process-group kill elsewhere. */
  killTree?: KillTree
  /** Environment for shell commands. Defaults to process.env minus the app's own variables. */
  env?: NodeJS.ProcessEnv
  limits?: Partial<ToolLimits>
  /** Monotonic clock in ms, for time caps and audit durations. */
  now?: () => number
  /**
   * Called when the audit sink throws or rejects. The tool call still returns
   * normally; surface this (and AuditLog.healthy) so the user knows logging broke.
   */
  onAuditFailure?: (error: unknown) => void
}

export interface ResolvedDeps {
  guard: PathGuard
  platform: NodeJS.Platform
  limits: ToolLimits
  trash: (path: string) => Promise<void>
  spawn: ShellSpawner
  killTree: KillTree
  env: NodeJS.ProcessEnv
  now: () => number
}
