import type { SystemOcr } from '../documents/system-ocr'
import type { DocumentReader } from '../documents/types'
import type { AuditSink } from '../permissions/audit'
import type { DocumentTextCacheLike } from './document-text-cache'
import type { PathGuard } from '../permissions/guard'
import type { FindJobLauncher } from './job-launcher'
import type { OcrIndexStatus, OcrPriority } from './ocr-priority'
import type { KillTree, ShellSpawner } from './run-shell'
import { MAX_TREE_ENTRIES } from './walk'
import { MAX_REPORTED_KEYS } from './search-cursor'
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
  /**
   * One search_files call's time budget, documents included. A call that runs out says how
   * far it got; calling again continues, documents already read coming from the cache.
   */
  searchTimeMs: number
  /**
   * The most PDFs one search_files cursor's reported set holds (PDFs reported out of path
   * order); once full, scanned PDFs go in path order. Lowered in tests.
   */
  maxReportedKeys: number
  /** One pattern match over one file's lines (or a batch of names); a slower pattern ends the search. */
  searchPatternTimeMs: number
  /** Characters of matches (and their context) one search_files result holds; the rest is cut. */
  maxSearchOutputChars: number
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
  searchTimeMs: 3 * 60_000,
  maxReportedKeys: MAX_REPORTED_KEYS,
  searchPatternTimeMs: 30_000,
  maxSearchOutputChars: 40_000,
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
  /**
   * Reads scanned PDF pages for search_files (ocr-text.exe on Windows), which needs the reader
   * and the cache as well. Without one, those pages are reported as not read.
   */
  ocr?: SystemOcr
  /**
   * Shared with background indexing of scanned pages: a search reading documents claims it,
   * and indexing makes way. Without one, nothing is indexing.
   */
  ocrPriority?: OcrPriority
  /** How background indexing is going, for search_files to mention. */
  ocrIndex?: OcrIndexStatus
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
  ocr: SystemOcr | null
  ocrPriority: OcrPriority | null
  ocrIndex: OcrIndexStatus | null
  now: () => number
}
