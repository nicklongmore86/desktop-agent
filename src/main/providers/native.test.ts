import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { claudeOptions } from './claude'
import { codexAccount, connectCodex } from './codex'
import { object } from './rpc'
import {
  capture,
  CLAUDE_VERSION,
  CODEX_VERSION,
  runtimeEnv,
  discoverRuntime,
  bundledRuntimeCandidates,
  runtimeCandidates,
  RUNTIME_PINS,
} from './runtime'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'Desktop provider isolation '))
  dirs.push(root)
  const home = join(root, 'host')
  const auth = join(root, 'auth')
  const cwd = join(root, 'workspace with spaces')
  await Promise.all([home, auth, cwd].map((dir) => mkdir(dir)))
  const env = {
    ...runtimeEnv(),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: auth,
    CLAUDE_CONFIG_DIR: auth,
  }
  return { root, home, auth, cwd, env }
}

it('pinned native Codex accepts isolated dynamic tools without API keys or sign-in', async () => {
  const f = await fixture()
  const resourcesPath = process.env['DESKTOP_TEST_RESOURCES']
  const original = await discoverRuntime(
    'codex',
    {},
    resourcesPath
      ? { resourcesPath, home: f.home, cwd: f.cwd, env: f.env }
      : { home: f.home, cwd: f.cwd, env: f.env },
  )
  expect(original).not.toBeNull()
  if (!original) throw new Error('Missing native Codex')
  let file = original
  if (resourcesPath) {
    const packaged = bundledRuntimeCandidates(
      'codex',
      resourcesPath,
      process.platform,
      process.arch,
    )[0]
    if (!packaged) throw new Error('Unsupported test platform')
    expect(file).toBe(await realpath(packaged))
  } else {
    // Exercise the nested optional-package layout used by global npm installs,
    // preserving all companions and testing paths with spaces without a Node shim.
    const npm = join(f.root, 'npm with spaces')
    const candidate = runtimeCandidates('codex', npm, process.platform, process.arch).find(
      (path) =>
        path.replaceAll('\\', '/').includes('codex/node_modules/@openai/') &&
        path.replaceAll('\\', '/').includes('/bin/'),
    )
    if (!candidate) throw new Error('Missing nested npm candidate')
    await cp(dirname(dirname(file)), dirname(dirname(candidate)), { recursive: true })
    const discovered = await discoverRuntime(
      'codex',
      { PATH: npm },
      {
        development: false,
        home: f.home,
        cwd: f.cwd,
        env: f.env,
      },
    )
    // Discovery returns canonical paths (tmpdir may be an 8.3 short name on Windows).
    expect(discovered).toBe(await realpath(candidate))
    if (!discovered) throw new Error('Nested npm discovery failed')
    file = discovered
  }
  await mkdir(join(f.home, '.codex'))
  await writeFile(
    join(f.home, '.codex', 'config.toml'),
    'notify = ["nonexistent-inherited-hook"]\n[mcp_servers.inherited]\ncommand="nonexistent-inherited-mcp"\n',
  )
  await writeFile(join(f.cwd, 'AGENTS.md'), 'HOSTILE_PROJECT_CONTEXT_MUST_NOT_LOAD')
  expect(await capture(file, ['--version'], f.cwd, f.env)).toContain(CODEX_VERSION)
  const peer = await connectCodex({ file, cwd: f.cwd, env: f.env })
  try {
    expect(await codexAccount(peer)).toBe(false)
    const result = await peer.request('thread/start', {
      cwd: f.cwd,
      ephemeral: true,
      environments: [],
      selectedCapabilityRoots: [],
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      dynamicTools: [
        {
          name: 'guarded_read',
          description: 'Desktop guard',
          inputSchema: { type: 'object', properties: {} },
          deferLoading: false,
        },
      ],
    })
    expect(object(result['thread'])['environments']).toEqual([])
    expect(result['runtimeWorkspaceRoots']).toEqual([])
    expect(result['instructionSources']).toEqual([])
    const mcp = await peer.request('mcpServerStatus/list', {})
    expect(mcp['data']).toEqual([])
  } finally {
    peer.close()
  }
}, 30000)

it('pinned native Claude ignores hostile project hooks, MCP and instructions with built-ins disabled', async () => {
  const f = await fixture()
  const original = await discoverRuntime('claude', {}, { home: f.home, cwd: f.cwd, env: f.env })
  expect(original).not.toBeNull()
  if (!original) throw new Error('Missing native Claude')
  let file: string | null = original
  const pin = RUNTIME_PINS[`${process.platform}-${process.arch}`]?.claude
  const tested = process.env['DESKTOP_TEST_RESOURCES']
  if (tested || pin) {
    // Exercise packaged discovery (integrity verification, no PATH fallback) where a
    // bundle is pinned, using the development binary in the packaged layout when needed.
    const resourcesPath = tested ?? join(f.root, 'resources')
    const bundled = bundledRuntimeCandidates(
      'claude',
      resourcesPath,
      process.platform,
      process.arch,
    )[0]
    if (!bundled || !pin) throw new Error('Unsupported test platform')
    if (!tested) {
      await mkdir(dirname(bundled), { recursive: true })
      await cp(original, bundled)
      await mkdir(join(resourcesPath, 'runtimes'))
      await writeFile(
        join(resourcesPath, 'runtimes', 'integrity.json'),
        JSON.stringify({
          claude: { path: pin.executable, sha256: pin.files[pin.executable] },
          files: {},
        }),
      )
    }
    file = await discoverRuntime(
      'claude',
      {},
      { resourcesPath, home: f.home, cwd: f.cwd, env: f.env },
    )
    expect(file).toBe(await realpath(bundled))
  }
  if (!file) throw new Error('Missing packaged Claude')
  await mkdir(join(f.cwd, '.claude'))
  await writeFile(
    join(f.cwd, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo bypass > bypass-marker.txt' }] },
        ],
      },
    }),
  )
  await writeFile(
    join(f.cwd, '.mcp.json'),
    JSON.stringify({ mcpServers: { inherited: { command: 'nonexistent-inherited-mcp' } } }),
  )
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'HOSTILE_PROJECT_CONTEXT_MUST_NOT_LOAD')
  expect(await capture(file, ['--version'], f.cwd, f.env)).toContain(CLAUDE_VERSION)
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, 15000)
  const stream = query({
    prompt: 'hello',
    options: { ...claudeOptions({ file, cwd: f.cwd, env: f.env }), abortController: controller },
  })
  try {
    let initialized = false
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        expect(message.tools).toEqual([])
        expect(message.mcp_servers).toEqual([])
        expect(message.skills).toEqual([])
        expect(message.slash_commands).toEqual([])
        expect(message.apiKeySource).toBe('none')
        initialized = true
        break
      }
    }
    expect(initialized).toBe(true)
    await expect(readFile(join(f.cwd, 'bypass-marker.txt'))).rejects.toThrow()
  } finally {
    clearTimeout(timer)
    controller.abort()
    stream.close()
  }
}, 30000)
