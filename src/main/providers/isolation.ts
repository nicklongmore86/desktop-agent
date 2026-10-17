import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeContext } from './codex'
import {
  CLAUDE_VERSION,
  CODEX_VERSION,
  discoverRuntime,
  providerDirectories,
  runtimeEnv,
  type RuntimeName,
} from './runtime'

/**
 * A bundled runtime's isolated directory (userData/providers/<runtime>), refused if
 * any user configuration has appeared in it, with the clean environment and the
 * executable discovery checked against its pin.
 */
export async function isolatedContext(
  userData: string,
  name: RuntimeName,
  signal?: AbortSignal,
): Promise<RuntimeContext> {
  const { home, cwd } = await providerDirectories(userData, name)
  // This directory is exclusively provider-owned auth storage. Never inherit user configuration.
  for (const name of [
    'config.toml',
    'settings.json',
    'settings.local.json',
    '.mcp.json',
    'CLAUDE.md',
    'AGENTS.md',
    'hooks.json',
    'plugins',
    '.claude',
    '.codex',
  ]) {
    for (const parent of [home, cwd]) {
      try {
        await lstat(join(parent, name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      throw new Error(
        'Unsupported runtime configuration in the isolated provider directory: ' + name,
      )
    }
  }
  if (name === 'codex') {
    const skills = await readdir(join(home, 'skills')).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    if (skills.some((entry) => entry !== '.system'))
      throw new Error('Unsupported custom skills in the isolated provider directory.')
  }
  const env = {
    ...runtimeEnv(),
    ...(name === 'claude'
      ? { CLAUDE_CONFIG_DIR: home, DISABLE_AUTOUPDATER: '1' }
      : { CODEX_HOME: home }),
  }
  // Discovery has already checked the pinned version (and, when packaged, integrity).
  const file = await discoverRuntime(name, process.env, { cwd, env, signal })
  if (!file)
    throw new Error(
      `Missing runtime: ${name} ${name === 'claude' ? CLAUDE_VERSION : CODEX_VERSION}. Development builds require the pinned native runtime; installed builds include it.`,
    )
  return { file, cwd, env }
}
