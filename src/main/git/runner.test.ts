import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellSpawnOptions } from '../tools/run-shell'
import { configInvocation, filtersFromKeys, parseConfigKeys } from './repo-config'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGitRunner,
  DEVICE_EMPTY,
  ensureEmptyPaths,
  gitEnv,
  gitInvocation,
  type EmptyPaths,
} from './runner'

const target = { root: '/granted/repo', gitDir: '/granted/repo/.git' }

/** The neutralising -c settings, naming `empty` wherever a setting must point at nothing. */
const neutral = (empty: EmptyPaths) => [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${empty.hooks}`,
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
  '-c',
  'core.askPass=',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.allow=never',
  '-c',
  'log.showSignature=false',
  '-c',
  'submodule.recurse=false',
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  `core.excludesFile=${empty.file}`,
  '-c',
  `core.attributesFile=${empty.file}`,
  '-c',
  `diff.orderFile=${empty.file}`,
  '-c',
  `mailmap.file=${empty.file}`,
  '-c',
  'mailmap.blob=',
  '-c',
  'log.mailmap=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.splitIndex=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'color.ui=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.relative=false',
]
const NEUTRAL = neutral(DEVICE_EMPTY)
/** What Windows uses: the app's own empty file and hooks folder, never /dev/null. */
const WINDOWS_EMPTY: EmptyPaths = {
  file: 'C:\\Users\\me\\AppData\\Roaming\\Desktop Agent\\git-empty\\empty',
  hooks: 'C:\\Users\\me\\AppData\\Roaming\\Desktop Agent\\git-empty\\no-hooks',
}

describe('gitInvocation', () => {
  it('is the fixed flags, explicit git dir and work tree, every neutralising setting, then the subcommand', () => {
    expect(gitInvocation(target, [], ['status', '-z'], DEVICE_EMPTY)).toEqual([
      '--no-pager',
      '--no-optional-locks',
      '--literal-pathspecs',
      '--no-replace-objects',
      '--git-dir=/granted/repo/.git',
      '--work-tree=/granted/repo',
      ...NEUTRAL,
      'status',
      '-z',
    ])
  })

  it('on Windows names the app’s empty file and hooks folder, never /dev/null', () => {
    const args = gitInvocation(target, ['lfs'], ['status'], WINDOWS_EMPTY)
    expect(args.slice(6, 6 + NEUTRAL.length)).toEqual(neutral(WINDOWS_EMPTY))
    expect(args.join('\n')).not.toContain('/dev/null')
    expect(args).toContain(`core.hooksPath=${WINDOWS_EMPTY.hooks}`)
    expect(args).toContain(`core.excludesFile=${WINDOWS_EMPTY.file}`)
  })

  it("switches off every one of the repository's filter drivers", () => {
    const args = gitInvocation(target, ['lfs', 'Evil.Dotted'], ['diff'], DEVICE_EMPTY)
    expect(args.slice(6 + NEUTRAL.length, -1)).toEqual([
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false',
      '-c',
      'filter.Evil.Dotted.clean=',
      '-c',
      'filter.Evil.Dotted.smudge=',
      '-c',
      'filter.Evil.Dotted.process=',
      '-c',
      'filter.Evil.Dotted.required=false',
    ])
  })

  it('reads the config with includes off', () => {
    expect(configInvocation(target, DEVICE_EMPTY).slice(-5)).toEqual([
      'config',
      '--no-includes',
      '-z',
      '--get-regexp',
      '^(include|includeif|filter)\\.',
    ])
  })
})

describe('repository config', () => {
  it('collects filter names, keeping dots and case', () => {
    const keys = parseConfigKeys(
      'filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.required\ntrue\0filter.Evil.Dotted.smudge\nx\0',
    )
    expect(filtersFromKeys(keys)).toEqual({ ok: true, filters: ['lfs', 'Evil.Dotted'] })
  })

  it('refuses includes and names that cannot be passed with -c', () => {
    for (const key of [
      'include.path',
      'includeIf.gitdir:/x/.path',
      'filter.a=b.clean',
      'filter.a\tb.clean',
    ])
      expect(filtersFromKeys([key])).toMatchObject({ ok: false, refused: true })
  })
})

describe('gitEnv', () => {
  it('on Windows points the global config at the app’s empty file, not /dev/null', () => {
    const env = gitEnv(
      { Path: 'C:\\Windows', GIT_CONFIG_GLOBAL: 'C:\\dev\\null' },
      'win32',
      WINDOWS_EMPTY,
    )
    expect(env['GIT_CONFIG_GLOBAL']).toBe(WINDOWS_EMPTY.file)
    expect(Object.values(env)).not.toContain('/dev/null')
  })

  it('keeps only the allow-listed variables and adds the git safety variables', () => {
    const env = gitEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        ANTHROPIC_API_KEY: 'sk-ant-x',
        GITHUB_TOKEN: 'ghp_x',
        GIT_DIR: '/elsewhere',
        GIT_EXEC_PATH: '/evil',
        GIT_SSH_COMMAND: 'evil',
        GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
        LD_PRELOAD: '/evil.so',
        NODE_OPTIONS: '--require evil',
      },
      'linux',
      DEVICE_EMPTY,
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_ADVICE: '0',
      LC_ALL: 'C',
      LANGUAGE: 'C',
    })
  })
})

class FakeChild extends EventEmitter {
  readonly pid = 4242
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kill = vi.fn(() => true)
}

describe('createGitRunner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(platform: NodeJS.Platform = 'linux') {
    const child = new FakeChild()
    const calls: { file: string; args: readonly string[]; options: ShellSpawnOptions }[] = []
    const spawn = vi.fn((file: string, args: readonly string[], options: ShellSpawnOptions) => {
      calls.push({ file, args, options })
      return child
    })
    const git = platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git'
    const run = createGitRunner({
      git,
      platform,
      env: { PATH: '/usr/bin', SECRET_TOKEN: 'x' },
      spawn,
      empty: platform === 'win32' ? WINDOWS_EMPTY : DEVICE_EMPTY,
    })
    return { child, calls, run, git }
  }

  it('spawns the absolute git with exactly the given arguments, no shell, the minimal env', async () => {
    const { child, calls, run, git } = setup('win32')
    const args = gitInvocation(target, [], ['log'], WINDOWS_EMPTY)
    const done = run(args, '/granted/repo', { maxBytes: 100 })
    child.stdout.end('out')
    child.emit('close', 0, null)
    expect(await done).toMatchObject({ code: 0, truncated: false, timedOut: false })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.file).toBe(git)
    expect(call?.args).toEqual(args)
    expect(call?.options).toEqual({
      cwd: '/granted/repo',
      env: gitEnv({ PATH: '/usr/bin' }, 'win32', WINDOWS_EMPTY),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    })
    expect(call?.options).not.toHaveProperty('shell')
    expect(call?.options.env).not.toHaveProperty('SECRET_TOKEN')
    expect(call?.options.env['GIT_CONFIG_GLOBAL']).toBe(WINDOWS_EMPTY.file)
  })

  it('stops git once its output passes the cap', async () => {
    const { child, run } = setup()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const done = run(['x'], '/r', { maxBytes: 4 })
      child.stdout.write('123456789')
      await new Promise((resolve) => setImmediate(resolve))
      child.emit('close', null, 'SIGKILL')
      const result = await done
      expect(result.truncated).toBe(true)
      expect(result.stdout.toString()).toBe('1234')
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    } finally {
      kill.mockRestore()
    }
  })

  it('kills git when it takes too long', async () => {
    vi.useFakeTimers()
    const { child, run } = setup()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const done = run(['x'], '/r', { maxBytes: 4, timeoutMs: 1000 })
      vi.advanceTimersByTime(1000)
      child.emit('close', null, 'SIGKILL')
      expect(await done).toMatchObject({ timedOut: true, code: null })
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    } finally {
      kill.mockRestore()
    }
  })

  it('reports a git that cannot start', async () => {
    const { child, run } = setup()
    const done = run(['x'], '/r', { maxBytes: 4 })
    child.emit('error', new Error('spawn ENOENT'))
    expect(await done).toMatchObject({ code: null, stderr: 'spawn ENOENT' })
  })
})

describe('ensureEmptyPaths', () => {
  it('creates an empty file and an empty hooks folder, and rebuilds them if anything is added', async () => {
    const base = join(mkdtempSync(join(tmpdir(), 'git-empty-')), 'git-empty')
    try {
      const paths = await ensureEmptyPaths(base)
      expect(paths).toEqual({ file: join(base, 'empty'), hooks: join(base, 'no-hooks') })
      expect(readdirSync(paths.hooks)).toEqual([])
      // A planted hook, config text and an extra file are all gone on the next use.
      writeFileSync(join(paths.hooks, 'pre-commit'), '#!/bin/sh\n')
      writeFileSync(paths.file, '[core]\n\tfsmonitor = evil\n')
      mkdirSync(join(base, 'extra'))
      const again = await ensureEmptyPaths(base)
      expect(again).toEqual(paths)
      expect(readdirSync(paths.hooks)).toEqual([])
      expect(readdirSync(base).sort()).toEqual(['empty', 'no-hooks'])
      expect(statSync(paths.file).size).toBe(0)
    } finally {
      rmSync(join(base, '..'), { recursive: true, force: true })
    }
  })
})
