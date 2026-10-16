import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_INSTALL_URL } from '../../shared/ipc-git'
import { rootId } from '../files/location'
import { PathGuard } from '../permissions/guard'
import type { GitOutput, GitRunner } from './runner'
import { createGitService } from './service'

const output = (stdout: string, code = 0): GitOutput => ({
  code,
  stdout: Buffer.from(stdout),
  stderr: '',
  truncated: false,
  timedOut: false,
})

describe('git service with a fake git', () => {
  let grant: string
  let calls: { args: readonly string[]; cwd: string }[]
  let replies: Record<string, GitOutput>
  const runner = (): GitRunner => (args, cwd) => {
    calls.push({ args, cwd })
    const sub = args.slice(args.lastIndexOf('-c') + 2).join(' ')
    const key = Object.keys(replies).find((prefix) => sub.startsWith(prefix))
    return Promise.resolve(key ? (replies[key] as GitOutput) : output('', 0))
  }
  const service = (detected = true) =>
    createGitService({
      guard: new PathGuard({ roots: () => [grant] }),
      emit: () => undefined,
      openUrl: vi.fn(() => Promise.resolve()),
      runner,
      detect: () =>
        Promise.resolve(
          detected ? { ok: true, git: '/usr/bin/git', version: '2.45.0' } : { ok: false },
        ),
    })

  beforeEach(() => {
    grant = realpathSync(mkdtempSync(join(tmpdir(), 'git-service-')))
    mkdirSync(join(grant, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(grant, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    calls = []
    replies = {
      config: output('filter.lfs.clean\ngit-lfs clean\0'),
      'status ': output('# branch.oid (initial)\0# branch.head main\0? a.txt\0'),
    }
  })
  afterEach(() => {
    rmSync(grant, { recursive: true, force: true })
  })

  it('reads the config first, then runs every command with its filters switched off', async () => {
    const git = service()
    const result = await git.status({ rootId: rootId(grant), rel: '' })
    expect(result).toMatchObject({ ok: true, changes: [{ path: 'a.txt', area: 'untracked' }] })
    const subcommands = calls.map(({ args }) => args.slice(args.lastIndexOf('-c') + 2)[0])
    expect(subcommands).toEqual(['config', 'status', 'diff', 'diff'])
    for (const { args, cwd } of calls) {
      expect(cwd).toBe(grant)
      expect(args).toContain(`--git-dir=${join(grant, '.git')}`)
      expect(args).toContain(`--work-tree=${grant}`)
      expect(args).toContain('core.fsmonitor=false')
    }
    for (const { args } of calls.slice(1)) {
      expect(args).toContain('filter.lfs.clean=')
      expect(args).toContain('filter.lfs.process=')
    }
  })

  it('never runs git for a secret file’s diff', async () => {
    const git = service()
    const result = await git.diff({
      repo: { rootId: rootId(grant), rel: '' },
      area: 'staged',
      path: 'config/.env',
    })
    expect(result).toMatchObject({ ok: true, kind: 'hidden' })
    expect(calls.map(({ args }) => args.slice(args.lastIndexOf('-c') + 2)[0])).toEqual(['config'])
  })

  it('refuses repositories outside the grants and unknown shapes without running git', async () => {
    const git = service()
    expect(await git.status({ rootId: 'r0000000000000000', rel: '' })).toMatchObject({
      ok: false,
      code: 'gone',
    })
    expect(await git.status({ rootId: rootId(grant), rel: 'a/b' })).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })

  it('says git is missing and runs nothing', async () => {
    const git = service(false)
    expect(await git.overview()).toEqual({ git: 'missing' })
    expect(await git.log({ repo: { rootId: rootId(grant), rel: '' }, skip: 0 })).toMatchObject({
      ok: false,
      code: 'git-missing',
    })
    expect(calls).toEqual([])
  })

  it('opens only the fixed install page', async () => {
    const openUrl = vi.fn(() => Promise.resolve())
    const git = createGitService({
      guard: new PathGuard({ roots: () => [grant] }),
      emit: () => undefined,
      openUrl,
      runner,
      detect: () => Promise.resolve({ ok: false }),
    })
    await git.openInstallPage()
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(GIT_INSTALL_URL)
  })
})
