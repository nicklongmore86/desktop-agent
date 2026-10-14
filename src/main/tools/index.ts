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
export type { KillTree, ShellProcess, ShellSpawner, ShellSpawnOptions } from './run-shell'
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
    killTree: deps.killTree ?? defaultKillTree(platform, spawn, () => process.cwd()),
    env: shellEnv(deps.env ?? process.env),
    now: deps.now ?? (() => performance.now()),
  }
  const wrap = { guard: deps.guard, audit: deps.audit, now: resolved.now }
  return [
    defineTool(listDirTool(resolved), wrap),
    defineTool(readFileTool(resolved), wrap),
    defineTool(searchFilesTool(resolved), wrap),
    defineTool(writeFileTool(resolved), wrap),
    defineTool(moveFileTool(resolved), wrap),
    defineTool(deletePathTool(resolved), wrap),
    defineTool(runShellTool(resolved), wrap),
  ]
}
