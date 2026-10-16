import { z } from 'zod'
import {
  GIT_LOG_MAX_SKIP,
  GIT_MAX_PATH,
  GIT_MAX_WATCHED,
  gitChannels,
  type GitDiffRequest,
  type GitDiffResult,
  type GitLogRequest,
  type GitLogResult,
  type GitOverview,
  type GitRepoRef,
  type GitStatusResult,
} from '../shared/ipc-git'
import { FILES_MAX_REL } from '../shared/ipc-files'
import { ROOT_ID } from './files/location'
import type { IpcHandle } from './ipc-features'

export interface GitService {
  overview: () => Promise<GitOverview>
  status: (repo: GitRepoRef) => Promise<GitStatusResult>
  diff: (request: GitDiffRequest) => Promise<GitDiffResult>
  log: (request: GitLogRequest) => Promise<GitLogResult>
  watch: (repos: GitRepoRef[]) => Promise<void>
  openInstallPage: () => Promise<void>
}

// A repository is a granted folder's opaque id and a relative path, never an absolute
// path; a changed file is a path inside it. The service checks both again (git/repo.ts,
// git/hidden.ts).
const repoSchema = z.strictObject({
  rootId: z.string().regex(ROOT_ID),
  rel: z.string().max(FILES_MAX_REL),
})
const pathSchema = z.string().min(1).max(GIT_MAX_PATH)
const diffSchema = z.strictObject({
  repo: repoSchema,
  area: z.enum(['staged', 'unstaged', 'untracked']),
  path: pathSchema,
  oldPath: pathSchema.optional(),
})
const logSchema = z.strictObject({
  repo: repoSchema,
  skip: z.number().int().min(0).max(GIT_LOG_MAX_SKIP),
})
const watchSchema = z.array(repoSchema).max(GIT_MAX_WATCHED * 4)

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(message)
  return parsed.data
}

export function registerGitHandlers(handle: IpcHandle, git: GitService): void {
  handle(gitChannels.gitOverview, () => git.overview())
  handle(gitChannels.gitStatus, (value) =>
    git.status(parse(repoSchema, value, 'Unknown repository.')),
  )
  handle(gitChannels.gitDiff, (value) =>
    git.diff(parse(diffSchema, value, 'Invalid diff request.')),
  )
  handle(gitChannels.gitLog, (value) =>
    git.log(parse(logSchema, value, 'Invalid history request.')),
  )
  handle(gitChannels.gitWatch, (value) =>
    git.watch(parse(watchSchema, value, 'Invalid repositories to watch.')),
  )
  handle(gitChannels.gitOpenInstallPage, () => git.openInstallPage())
}
