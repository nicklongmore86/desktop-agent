import { defineTool } from './define'
import { DEFAULT_LIMITS, type ResolvedDeps, type ToolDeps } from './deps'
import { deletePathTool } from './delete-path'
import { listDirTool } from './list-dir'
import { moveFileTool } from './move-file'
import { readFileTool } from './read-file'
import { defaultKillTree, defaultSpawner, runShellTool, shellEnv } from './run-shell'
import { searchFilesTool } from './search-files'
import type { AgentTool } from './types'
import { writeFileTool } from './write-file'

export type { ToolDeps, ToolLimits } from './deps'
export { DEFAULT_LIMITS } from './deps'
export type {
  KillResult,
  KillTree,
  ShellProcess,
  ShellSpawner,
  ShellSpawnOptions,
} from './run-shell'
export type * from './types'

/**
 * The agent's file and shell tools. Every path goes through `deps.guard`,
 * every write/move/delete/shell call asks for approval through the call's
 * ToolContext, and every call is recorded in `deps.audit`. Tools never throw:
 * failures come back as `{ isError: true }` results.
 */
export function createTools(deps: ToolDeps): AgentTool[] {
  const platform = deps.guard.platform
  const spawn = deps.spawn ?? defaultSpawner
  const resolved: ResolvedDeps = {
    guard: deps.guard,
    platform,
    limits: { ...DEFAULT_LIMITS, ...deps.limits },
    trash: deps.trash,
    spawn,
    killTree: deps.killTree ?? defaultKillTree(platform, spawn, deps.env ?? process.env),
    env: shellEnv(deps.env ?? process.env),
    now: deps.now ?? (() => performance.now()),
  }
  const wrap = {
    guard: deps.guard,
    audit: deps.audit,
    now: resolved.now,
    onAuditFailure:
      deps.onAuditFailure ??
      ((error: unknown) => {
        console.error('audit sink failed', error)
      }),
  }
  return [
    defineTool(
      {
        name: 'list_granted_folders',
        description:
          'Discover the absolute paths of folders currently granted in Desktop Agent. Call this before file operations when the user names a folder without an absolute path. This does not grant new access.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        needsApproval: false,
        parse: () => ({}),
        summarize: () => ({}),
        async run(_input, call) {
          const roots: string[] = []
          for (const root of deps.guard.grantedRoots()) {
            const result = await deps.guard.resolve(root)
            call.throwIfAborted()
            if (result.ok && result.exists) roots.push(result.path)
          }
          return {
            content: JSON.stringify({
              roots,
              message: roots.length
                ? 'Use these paths with list_dir, read_file, and search_files.'
                : 'No accessible folders are granted. Ask the user to add a folder in Settings.',
            }),
          }
        },
      },
      wrap,
    ),
    defineTool(listDirTool(resolved), wrap),
    defineTool(readFileTool(resolved), wrap),
    defineTool(searchFilesTool(resolved), wrap),
    defineTool(writeFileTool(resolved), wrap),
    defineTool(moveFileTool(resolved), wrap),
    defineTool(deletePathTool(resolved), wrap),
    defineTool(runShellTool(resolved), wrap),
  ]
}
