// The panel's three reads, status, diff and log, each one git run (plus the numstat
// counts for status) through the hardened runner, and the parsing of their output.
// Contents are never returned for a file the panel hides (hidden.ts), and a diff is
// returned only when every file in it is the one that was asked for.
import {
  GIT_DIFF_MAX_BYTES,
  GIT_DIFF_MAX_LINES,
  GIT_LOG_PAGE,
  GIT_MAX_CHANGES,
  type GitBranch,
  type GitChange,
  type GitChangeStatus,
  type GitCommit,
  type GitDiffRequest,
  type GitDiffResult,
  type GitLogResult,
  type GitStatusResult,
} from '../../shared/ipc-git'
import type { PathGuard } from '../permissions/guard'
import { openVerified, readBounded } from '../tools/safe-fs'
import { hiddenReason, repoPath } from './hidden'
import { redactDiff } from './redact'
import { gitFailure } from './repo-config'
import {
  gitInvocation,
  type EmptyPaths,
  type FilterNames,
  type GitRunner,
  type GitTarget,
} from './runner'

export interface QueryContext {
  run: GitRunner
  target: GitTarget
  filters: FilterNames
  guard: PathGuard
  empty: EmptyPaths
}

const STATUS_MAX_BYTES = 8 * 1024 * 1024
const LOG_MAX_BYTES = 1024 * 1024

function invoke(ctx: QueryContext, subcommand: string[], maxBytes: number) {
  return ctx.run(gitInvocation(ctx.target, ctx.filters, subcommand, ctx.empty), ctx.target.root, {
    maxBytes,
  })
}

const failed = (reason: string) => ({ ok: false as const, code: 'failed' as const, reason })

/** Decodes a path git printed; null when it is not valid UTF-8. */
function decodePath(bytes: string): string | null {
  return bytes.includes('�') ? null : bytes
}

const STATUS_LETTERS: Record<string, GitChangeStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
}

export interface ParsedStatus {
  branch: GitBranch
  changes: GitChange[]
}

/** Parses `git status --porcelain=v2 -z --branch`. Exported for tests. */
export function parseStatus(output: string): ParsedStatus {
  const branch: GitBranch = { head: null, oid: null }
  const changes: GitChange[] = []
  const records = output.split('\0')
  const add = (change: GitChange, raw: string, rawOld?: string): void => {
    const path = decodePath(raw)
    const oldPath = rawOld === undefined ? undefined : decodePath(rawOld)
    changes.push({
      ...change,
      path: path ?? raw,
      ...(rawOld !== undefined ? { oldPath: oldPath ?? rawOld } : {}),
      ...(path === null || oldPath === null ? { unsafeName: true } : {}),
    })
  }
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? ''
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') branch.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          branch.ahead = Number(match[1])
          branch.behind = Number(match[2])
        }
      }
      continue
    }
    const type = record[0]
    if (type === '?') {
      add({ area: 'untracked', status: 'untracked', path: '' }, record.slice(2))
      continue
    }
    if (type !== '1' && type !== '2' && type !== 'u') continue
    // 1 XY sub mH mI mW hH hI path | 2 XY sub mH mI mW hH hI Xscore path\0orig | u XY sub m1 m2 m3 mW h1 h2 h3 path
    const fields = type === '1' ? 8 : type === '2' ? 9 : 10
    const parts = record.split(' ')
    const xy = parts[1] ?? '..'
    const path = parts.slice(fields).join(' ')
    if (type === 'u') {
      add({ area: 'unstaged', status: 'conflicted', path: '' }, path)
      continue
    }
    const orig = type === '2' ? (records[++i] ?? '') : undefined
    const x = STATUS_LETTERS[xy[0] ?? '.']
    const y = STATUS_LETTERS[xy[1] ?? '.']
    if (x)
      add(
        { area: 'staged', status: x, path: '' },
        path,
        x === 'renamed' || x === 'copied' ? orig : undefined,
      )
    if (y) add({ area: 'unstaged', status: y, path: '' }, path)
  }
  return { branch, changes }
}

export interface NumstatEntry {
  path: string
  additions?: number
  deletions?: number
  binary: boolean
}

/** Parses `git diff --numstat -z` (renames: `a\td\t\0old\0new\0`). Exported for tests. */
export function parseNumstat(output: string): NumstatEntry[] {
  const records = output.split('\0')
  const entries: NumstatEntry[] = []
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? ''
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record)
    if (!match) continue
    let path = match[3] ?? ''
    if (path === '') {
      i += 2
      path = records[i] ?? ''
    }
    const binary = match[1] === '-'
    entries.push({
      path,
      binary,
      ...(binary ? {} : { additions: Number(match[1]), deletions: Number(match[2]) }),
    })
  }
  return entries
}

const NUMSTAT = ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--find-renames']

export async function gitStatus(ctx: QueryContext): Promise<GitStatusResult> {
  const status = await invoke(
    ctx,
    [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
      '--ignore-submodules=all',
      '--find-renames',
    ],
    STATUS_MAX_BYTES,
  )
  if (status.truncated) return failed('This repository has too many changes to list.')
  if (status.code !== 0) return failed(gitFailure(status.stderr, status.timedOut))
  const parsed = parseStatus(status.stdout.toString('utf8'))

  const [unstaged, staged] = await Promise.all([
    invoke(ctx, [...NUMSTAT, '--'], STATUS_MAX_BYTES),
    invoke(ctx, [...NUMSTAT, '--cached', '--'], STATUS_MAX_BYTES),
  ])
  const counts = new Map<string, NumstatEntry>()
  for (const [area, result] of [
    ['unstaged', unstaged],
    ['staged', staged],
  ] as const) {
    // Counts are extras: a failure leaves them out.
    if (result.code !== 0 || result.truncated) continue
    for (const entry of parseNumstat(result.stdout.toString('utf8')))
      counts.set(`${area}\0${entry.path}`, entry)
  }

  const listed = parsed.changes.slice(0, GIT_MAX_CHANGES)
  const changes = await Promise.all(
    listed.map(async (change): Promise<GitChange> => {
      const hidden = change.unsafeName
        ? 'This name cannot be shown safely.'
        : await hiddenReason(ctx.guard, ctx.target.root, change.path, change.oldPath)
      if (hidden) return { ...change, hidden }
      const count = counts.get(`${change.area}\0${change.path}`)
      if (!count) return change
      return count.binary
        ? { ...change, binary: true }
        : { ...change, additions: count.additions ?? 0, deletions: count.deletions ?? 0 }
    }),
  )
  return {
    ok: true,
    branch: parsed.branch,
    changes,
    more: parsed.changes.length - listed.length,
  }
}

/**
 * The `diff --git` header lines a diff of `path` (and `oldPath`) may contain. A path is a
 * prefix in a pathspec, so `git diff -- a` also shows `a/.env` when the index has it;
 * any other header means the diff covers another file, and it is refused.
 */
function allowedHeaders(path: string, oldPath?: string): Set<string> {
  const headers = new Set([`diff --git a/${path} b/${path}`])
  if (oldPath !== undefined) {
    headers.add(`diff --git a/${oldPath} b/${oldPath}`)
    headers.add(`diff --git a/${oldPath} b/${path}`)
  }
  return headers
}

function tooLarge(text: string): boolean {
  let lines = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    lines += 1
    if (lines > GIT_DIFF_MAX_LINES) return true
  }
  return false
}

export async function gitDiff(
  ctx: QueryContext,
  request: Omit<GitDiffRequest, 'repo'>,
): Promise<GitDiffResult> {
  const { path, area } = request
  const oldPath = area === 'staged' ? request.oldPath : undefined
  const hidden = await hiddenReason(ctx.guard, ctx.target.root, path, oldPath)
  if (hidden) return { ok: true, kind: 'hidden', reason: hidden }
  if (area === 'untracked') return untrackedDiff(ctx, path)

  const result = await invoke(
    ctx,
    [
      'diff',
      ...(area === 'staged' ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--',
      path,
      ...(oldPath !== undefined ? [oldPath] : []),
    ],
    GIT_DIFF_MAX_BYTES + 1,
  )
  if (result.truncated) return { ok: true, kind: 'too-large' }
  if (result.code !== 0) return failed(gitFailure(result.stderr, result.timedOut))
  const text = result.stdout.toString('utf8')
  if (text === '') return { ok: true, kind: 'empty' }
  const allowed = allowedHeaders(path, oldPath)
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ') && !allowed.has(line))
      return failed('This diff includes other files, so it is not shown.')
  }
  if (/^Binary files .* differ$/m.test(text) && !/^@@ /m.test(text))
    return { ok: true, kind: 'binary' }
  if (tooLarge(text)) return { ok: true, kind: 'too-large' }
  const { text: diff, redacted } = redactDiff(text)
  return { ok: true, kind: 'text', diff, redacted }
}

/** An untracked file is read by us (not git), through the same checks as the agent's reads. */
async function untrackedDiff(ctx: QueryContext, path: string): Promise<GitDiffResult> {
  const absolute = repoPath(ctx.guard, ctx.target.root, path)
  if (!absolute) return { ok: true, kind: 'hidden', reason: 'This name cannot be shown safely.' }
  let bytes: Buffer
  try {
    const { handle } = await openVerified(ctx.guard, absolute, 'read')
    try {
      bytes = await readBounded(handle, GIT_DIFF_MAX_BYTES + 1)
    } finally {
      await handle.close()
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'The file cannot be read.')
  }
  if (bytes.length > GIT_DIFF_MAX_BYTES) return { ok: true, kind: 'too-large' }
  if (bytes.subarray(0, 8000).includes(0)) return { ok: true, kind: 'binary' }
  if (bytes.length === 0) return { ok: true, kind: 'empty' }
  const content = bytes.toString('utf8')
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > GIT_DIFF_MAX_LINES) return { ok: true, kind: 'too-large' }
  const header = [
    `diff --git a/${path} b/${path}`,
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
  ]
  const { text, redacted } = redactDiff([...header, ...lines.map((line) => `+${line}`)].join('\n'))
  return { ok: true, kind: 'text', diff: text, redacted }
}

const FIELD = '\x1f'

/** Parses `git log -z --format=%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%s`. Exported for tests. */
export function parseLog(output: string): GitCommit[] {
  return output
    .split('\0')
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [hash = '', short = '', author = '', at = '0', parents = '', ...subject] = record
        .replace(/^\n/, '')
        .split(FIELD)
      return {
        hash,
        short,
        author: author.slice(0, 200),
        date: Number(at) * 1000,
        // A subject with the separator in it keeps it.
        subject: subject.join(FIELD).slice(0, 500),
        merge: parents.trim().split(' ').length > 1,
      }
    })
}

export async function gitLog(ctx: QueryContext, skip: number): Promise<GitLogResult> {
  const result = await invoke(
    ctx,
    [
      'log',
      '--no-show-signature',
      '--no-mailmap',
      '--no-color',
      '--no-decorate',
      '-z',
      '--format=%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%s',
      `--max-count=${String(GIT_LOG_PAGE + 1)}`,
      `--skip=${String(skip)}`,
      'HEAD',
      '--',
    ],
    LOG_MAX_BYTES,
  )
  if (result.code !== 0 || result.truncated) {
    // No commits yet: HEAD names a branch that does not exist.
    const head = await invoke(ctx, ['rev-parse', '-q', '--verify', 'HEAD'], 4096)
    if (head.code === 1 && head.stdout.length === 0) return { ok: true, commits: [], more: false }
    return failed(gitFailure(result.stderr, result.timedOut))
  }
  const commits = parseLog(result.stdout.toString('utf8'))
  return { ok: true, commits: commits.slice(0, GIT_LOG_PAGE), more: commits.length > GIT_LOG_PAGE }
}
