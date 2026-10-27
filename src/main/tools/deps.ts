import type { DocumentReader } from '../documents/types'
import type { AuditSink } from '../permissions/audit'
import type { DocumentTextCacheLike } from './document-text-cache'
import type { PathGuard } from '../permissions/guard'
import type { FindJobLauncher } from './job-launcher'
import type { KillTree, ShellSpawner } from './run-shell'
import { MAX_TREE_ENTRIES } from './walk'
import { TREE_KILL_SECONDS } from './shell-windows'

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
  /** Of searchTimeMs, the most spent reading documents through the reader. */
  searchDocumentTimeMs: number
  /** Documents search_files reads through the reader per call (cached ones do not count). */
  maxSearchDocuments: number
  /** Characters of one document's text searched; the rest is reported as not searched. */
  maxSearchDocumentChars: number
  /** Reader calls for one document (pages, slides and cells come a part per call). */
  maxSearchDocumentCalls: number
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
  /**
   * How long killing a shell's process tree may take before it is reported as not done
   * (at least killGraceMs): on Windows, taskkill and then the PowerShell fallback, which
   * has TREE_KILL_SECONDS of its own plus time to start on a busy machine.
   */
  killTimeoutMs: number
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
  searchTimeMs: 30_000,
  searchDocumentTimeMs: 20_000,
  maxSearchDocuments: 25,
  maxSearchDocumentChars: 2_000_000,
  maxSearchDocumentCalls: 40,
  maxScanEntries: MAX_TREE_ENTRIES,
  maxDiffBytes: 256 * 1024,
  defaultShellTimeoutMs: 60_000,
  maxShellTimeoutMs: 10 * 60_000,
  maxShellOutputBytes: 100_000,
  killGraceMs: 5000,
  killTimeoutMs: (TREE_KILL_SECONDS + 7) * 1000,
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
  /**
   * Windows: the verified job-run.exe that contains each command in a Job Object.
   * Defaults to the installed app's pinned helper; without one, killTree applies.
   */
  jobLauncher?: FindJobLauncher
  /** Environment for shell commands. Defaults to process.env minus the app's own variables. */
  env?: NodeJS.ProcessEnv
  limits?: Partial<ToolLimits>
  /**
   * Parses documents and images for read_document, out of process (DocumentWorkerHost).
   * Without one, read_document answers that reading documents is unavailable.
   */
  documents?: DocumentReader
  /**
   * Keeps the text search_files extracts from documents (DocumentTextCache under userData).
   * Without one, every search reads its documents again.
   */
  documentCache?: DocumentTextCacheLike
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
  jobLauncher: FindJobLauncher
  env: NodeJS.ProcessEnv
  documents: DocumentReader | null
  documentCache: DocumentTextCacheLike | null
  now: () => number
}
