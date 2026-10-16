// The Git panel against the real git, in temporary repositories: a hostile repository
// whose hooks, fsmonitor, diff driver, textconv and clean/smudge filter would each
// create a marker file, repositories whose git folder is outside the grants, secrets,
// and the degraded states. Runs on Linux and Windows CI (git is installed on both).
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitDiffResult, GitRepoRef, GitStatusResult } from '../../shared/ipc-git'
import { rootId } from '../files/location'
import { PathGuard } from '../permissions/guard'
import { findGit } from './detect'
import { createGitService } from './service'

const platform = process.platform
const gitPath = await findGit({ platform, env: process.env, grantedRoots: () => [] })
const SECRET = 'sk-live-THISMUSTNEVERLEAVEMAIN0123456789'

/** Plain git for building fixtures (and the control run): the developer's config ignored. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    gitPath as string,
    [
      '-c',
      'init.defaultBranch=main',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgSign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  )
}

const slash = (p: string): string => p.replace(/\\/g, '/')

describe.runIf(gitPath)('git panel with the real git', () => {
  let base: string
  let grant: string
  let outside: string
  let markers: string
  let service: ReturnType<typeof createGitService>
  const ref = (rel: string): GitRepoRef => ({ rootId: rootId(grant), rel })

  const writeScript = (name: string, body: string): string => {
    const file = join(markers, '..', 'scripts', name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
    return slash(file)
  }
  const marked = (): string[] => readdirSync(markers)
  const okStatus = (result: GitStatusResult) => {
    if (!result.ok) throw new Error(result.reason)
    return result
  }
  const text = (result: GitDiffResult): string => {
    if (!result.ok || result.kind !== 'text') throw new Error(JSON.stringify(result))
    return result.diff
  }

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'git-panel-')))
    grant = join(base, 'granted')
    outside = join(base, 'outside')
    markers = join(base, 'markers')
    for (const dir of [grant, outside, markers, join(base, 'scripts')]) mkdirSync(dir)
    const guard = new PathGuard({ roots: () => [grant] })
    service = createGitService({
      guard,
      emit: () => undefined,
      openUrl: () => Promise.resolve(),
      emptyDir: join(base, 'git-empty'),
    })

    // hostile: a normal history, then everything a downloaded repository could configure.
    const hostile = join(grant, 'hostile')
    mkdirSync(hostile)
    git(hostile, 'init', '-q')
    writeFileSync(join(hostile, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(hostile, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 5]))
    writeFileSync(join(hostile, 'cfg'), 'plain\n')
    git(hostile, 'add', '.')
    git(hostile, 'commit', '-q', '-m', 'first')
    writeFileSync(join(hostile, 'a.txt'), 'one\ntwo\nthree\n')
    git(hostile, 'commit', '-q', '-am', 'second ‮evil')
    const mark = (name: string): string => `echo hit > "${slash(join(markers, name))}"`
    const filter = writeScript('filter.sh', `${mark('filter')}\ncat`)
    const textconv = writeScript('textconv.sh', `${mark('textconv')}\ncat "$1"`)
    const external = writeScript('external.sh', `${mark('external')}\nexit 0`)
    const fsmonitor = writeScript('fsmonitor.sh', `${mark('fsmonitor')}\nexit 1`)
    const gpg = writeScript('gpg.sh', `${mark('gpg')}\nexit 1`)
    const pager = writeScript('pager.sh', `${mark('pager')}\ncat`)
    writeFileSync(
      join(hostile, '.git', 'config'),
      [
        '[core]',
        '\trepositoryformatversion = 0',
        '\tbare = false',
        `\tfsmonitor = ${fsmonitor}`,
        `\tpager = ${pager}`,
        '[diff]',
        `\texternal = ${external}`,
        '[diff "evil"]',
        `\ttextconv = ${textconv}`,
        `\tcommand = ${external}`,
        '[filter "evil"]',
        `\tclean = ${filter}`,
        `\tsmudge = ${filter}`,
        '\trequired = true',
        '[filter "Evil.Dotted"]',
        `\tclean = ${filter}`,
        '[log]',
        '\tshowSignature = true',
        '[gpg]',
        `\tprogram = ${gpg}`,
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(hostile, '.git', 'info', 'attributes'),
      '* diff=evil filter=evil\n*.txt filter=Evil.Dotted\n',
    )
    for (const hook of [
      'post-index-change',
      'pre-commit',
      'post-checkout',
      'reference-transaction',
      'pre-auto-gc',
      'fsmonitor-watchman',
    ])
      writeFileSync(join(hostile, '.git', 'hooks', hook), `#!/bin/sh\n${mark(`hook-${hook}`)}\n`, {
        mode: 0o755,
      })
    // Changes: a modified file (same size, newer time: git must hash it, through the
    // clean filter), a staged secret, an untracked secret, a binary change.
    writeFileSync(join(hostile, 'a.txt'), 'one\ntwo\nTHREE\n')
    utimesSync(join(hostile, 'a.txt'), new Date(), new Date(Date.now() + 5000))
    writeFileSync(join(hostile, 'image.bin'), Buffer.from([0, 9, 9, 9, 0, 5]))
    writeFileSync(join(hostile, 'notes.md'), `untracked\napi_key = ${SECRET}\n`)
    writeFileSync(join(hostile, '.env'), `TOKEN=${SECRET}\n`)
    writeFileSync(join(hostile, '.env.local'), `TOKEN=${SECRET}\n`)
  })

  afterAll(() => {
    service.close()
    rmSync(base, { recursive: true, force: true })
  })

  it('the hostile fixture really runs its programs under plain git (control)', () => {
    const hostile = join(grant, 'hostile')
    try {
      git(hostile, 'status', '--porcelain')
      git(hostile, 'diff', '--', 'a.txt')
    } catch {
      // Failing hooks may fail the command; the markers are what matter.
    }
    const hit = marked()
    if (platform === 'win32') expect(hit.length).toBeGreaterThan(0)
    else expect(hit).toEqual(expect.arrayContaining(['filter', 'external', 'fsmonitor']))
    for (const name of hit) rmSync(join(markers, name))
    // The panel reads the same timestamps: make a.txt stat-dirty again.
    utimesSync(join(hostile, 'a.txt'), new Date(), new Date(Date.now() + 10_000))
  })

  it('lists, diffs and logs the hostile repository without running any of it', async () => {
    const overview = await service.overview()
    expect(overview.git).toBe('found')
    if (overview.git !== 'found') return
    const folder = overview.folders[0]
    expect(folder?.repos.find((r) => r.rel === 'hostile')?.kind).toBe('repo')

    const status = okStatus(await service.status(ref('hostile')))
    expect(status.branch).toMatchObject({ head: 'main' })
    const byPath = (path: string, area: string) =>
      status.changes.find((c) => c.path === path && c.area === area)
    expect(byPath('a.txt', 'unstaged')).toMatchObject({ status: 'modified' })
    expect(byPath('image.bin', 'unstaged')).toMatchObject({ binary: true })
    expect(byPath('notes.md', 'untracked')).toBeDefined()
    expect(byPath('.env', 'untracked')?.hidden).toMatch(/secrets file/)

    const diff = text(await service.diff({ repo: ref('hostile'), area: 'unstaged', path: 'a.txt' }))
    expect(diff).toContain('-three')
    expect(diff).toContain('+THREE')
    expect(
      await service.diff({ repo: ref('hostile'), area: 'unstaged', path: 'image.bin' }),
    ).toEqual({ ok: true, kind: 'binary' })
    const untracked = await service.diff({
      repo: ref('hostile'),
      area: 'untracked',
      path: 'notes.md',
    })
    expect(text(untracked)).toContain('+untracked')
    expect(text(untracked)).not.toContain(SECRET)
    expect(untracked).toMatchObject({ redacted: true })

    const log = await service.log({ repo: ref('hostile'), skip: 0 })
    if (!log.ok) throw new Error(log.reason)
    expect(log.commits.map((c) => c.subject)).toEqual(['second ‮evil', 'first'])
    expect(log.more).toBe(false)

    expect(marked()).toEqual([])
  })

  it('never returns a secret file’s contents, even through a path prefix', async () => {
    const repo = join(grant, 'secrets')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'cfg'), 'plain\n')
    writeFileSync(join(repo, '.env'), 'A=1\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    writeFileSync(join(repo, '.env'), `A=${SECRET}\n`)
    git(repo, 'add', '.env')
    // `cfg` becomes a folder holding a secret: `git diff --cached -- cfg` would show it.
    git(repo, 'rm', '-q', 'cfg')
    mkdirSync(join(repo, 'cfg'))
    writeFileSync(join(repo, 'cfg', 'notes.txt'), `${SECRET}\n`)
    writeFileSync(join(repo, 'cfg', '.env'), `B=${SECRET}\n`)
    git(repo, 'add', 'cfg')
    // ...and a plain file again in the working tree, so only the diff check stops it.
    rmSync(join(repo, 'cfg'), { recursive: true })
    writeFileSync(join(repo, 'cfg'), 'plain again\n')

    const status = okStatus(await service.status(ref('secrets')))
    expect(JSON.stringify(status)).not.toContain(SECRET)
    expect(status.changes.find((c) => c.path === '.env')).toMatchObject({
      area: 'staged',
      status: 'modified',
      hidden: expect.stringMatching(/secrets file/) as unknown,
    })
    for (const area of ['staged', 'unstaged'] as const) {
      const result = await service.diff({ repo: ref('secrets'), area, path: '.env' })
      expect(result).toMatchObject({ ok: true, kind: 'hidden' })
      expect(JSON.stringify(result)).not.toContain(SECRET)
    }
    const prefix = await service.diff({ repo: ref('secrets'), area: 'staged', path: 'cfg' })
    expect(prefix).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/other files/) as unknown,
    })
    expect(JSON.stringify(prefix)).not.toContain(SECRET)
  })

  it('refuses a repository whose git folder is outside the grants', async () => {
    const real = join(outside, 'real')
    mkdirSync(real)
    git(real, 'init', '-q')
    const pointer = join(grant, 'pointer')
    mkdirSync(pointer)
    writeFileSync(join(pointer, '.git'), `gitdir: ${join(real, '.git')}\n`)
    writeFileSync(join(pointer, 'file.txt'), 'x\n')

    const overview = await service.overview()
    if (overview.git !== 'found') throw new Error('git missing')
    const entry = overview.folders[0]?.repos.find((r) => r.rel === 'pointer')
    expect(entry).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/outside/) as unknown,
    })
    expect(await service.status(ref('pointer'))).toMatchObject({ ok: false, code: 'refused' })
    expect(await service.log({ repo: ref('pointer'), skip: 0 })).toMatchObject({ ok: false })
  })

  it.skipIf(platform === 'win32')('refuses a .git that is a symbolic link', async () => {
    const linked = join(grant, 'linked')
    mkdirSync(linked)
    const real = join(outside, 'linked-real')
    mkdirSync(real)
    git(real, 'init', '-q')
    symlinkSync(join(real, '.git'), join(linked, '.git'))
    expect(await service.status(ref('linked'))).toMatchObject({ ok: false, code: 'refused' })
  })

  it('refuses a repository whose settings include other files', async () => {
    const repo = join(grant, 'includes')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'include.path', '//server/share/config')
    expect(await service.status(ref('includes'))).toMatchObject({
      ok: false,
      code: 'refused',
      reason: expect.stringMatching(/include other files/) as unknown,
    })
  })

  it('refuses a repository that borrows objects from elsewhere', async () => {
    const repo = join(grant, 'alternates')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(outside, 'x')}\n`)
    expect(await service.status(ref('alternates'))).toMatchObject({ ok: false, code: 'refused' })
  })

  it('handles an empty repository, a detached HEAD and a huge diff', async () => {
    const empty = join(grant, 'empty')
    mkdirSync(empty)
    git(empty, 'init', '-q')
    writeFileSync(join(empty, 'new.txt'), 'hello\n')
    const status = okStatus(await service.status(ref('empty')))
    expect(status.branch).toEqual({ head: 'main', oid: null })
    expect(await service.log({ repo: ref('empty'), skip: 0 })).toEqual({
      ok: true,
      commits: [],
      more: false,
    })

    const detached = join(grant, 'detached')
    mkdirSync(detached)
    git(detached, 'init', '-q')
    writeFileSync(join(detached, 'big.txt'), 'a\n')
    git(detached, 'add', '.')
    git(detached, 'commit', '-q', '-m', 'one')
    git(detached, 'checkout', '-q', '--detach')
    writeFileSync(join(detached, 'big.txt'), 'line\n'.repeat(10_000))
    const detachedStatus = okStatus(await service.status(ref('detached')))
    expect(detachedStatus.branch.head).toBeNull()
    expect(detachedStatus.branch.oid).toMatch(/^[0-9a-f]{40}$/)
    expect(
      await service.diff({ repo: ref('detached'), area: 'unstaged', path: 'big.txt' }),
    ).toEqual({ ok: true, kind: 'too-large' })
  })

  it('shows ahead/behind from local refs only', async () => {
    const upstream = join(grant, 'upstream')
    mkdirSync(upstream)
    git(upstream, 'init', '-q')
    writeFileSync(join(upstream, 'f.txt'), '1\n')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '-q', '-m', 'one')
    git(upstream, 'branch', 'base')
    git(upstream, 'branch', '--set-upstream-to=base')
    writeFileSync(join(upstream, 'f.txt'), '2\n')
    git(upstream, 'commit', '-q', '-am', 'two')
    const status = okStatus(await service.status(ref('upstream')))
    expect(status.branch).toMatchObject({ head: 'main', upstream: 'base', ahead: 1, behind: 0 })
  })

  it('hides a file that has other hard links', async () => {
    const repo = join(grant, 'hardlink')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'h.txt'), 'a\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    writeFileSync(join(repo, 'h.txt'), 'b\n')
    linkSync(join(repo, 'h.txt'), join(outside, 'alias.txt'))
    const status = okStatus(await service.status(ref('hardlink')))
    expect(status.changes[0]?.hidden).toMatch(/hard links/)
    expect(
      await service.diff({ repo: ref('hardlink'), area: 'unstaged', path: 'h.txt' }),
    ).toMatchObject({ ok: true, kind: 'hidden' })
  })

  it('refuses a granted folder inside a repository that is not granted', async () => {
    const outer = join(outside, 'outer')
    mkdirSync(join(outer, 'inner'), { recursive: true })
    git(outer, 'init', '-q')
    const guard = new PathGuard({ roots: () => [join(outer, 'inner')] })
    const inner = createGitService({
      guard,
      emit: () => undefined,
      openUrl: () => Promise.resolve(),
      emptyDir: join(base, 'git-empty-inner'),
    })
    const overview = await inner.overview()
    if (overview.git !== 'found') throw new Error('git missing')
    expect(overview.folders[0]?.repos).toEqual([
      expect.objectContaining({
        kind: 'refused',
        reason: expect.stringMatching(/inside the git repository/) as unknown,
      }),
    ])
    expect(existsSync(join(outer, '.git', 'index'))).toBe(false)
  })

  it('says so when the enclosing repository is itself granted', async () => {
    const outer = join(grant, 'nested-outer')
    mkdirSync(join(outer, 'src'), { recursive: true })
    git(outer, 'init', '-q')
    const guard = new PathGuard({ roots: () => [outer, join(outer, 'src')] })
    const nested = createGitService({
      guard,
      emit: () => undefined,
      openUrl: () => Promise.resolve(),
      emptyDir: join(base, 'git-empty-nested'),
    })
    const overview = await nested.overview()
    if (overview.git !== 'found') throw new Error('git missing')
    expect(overview.folders[0]?.repos[0]).toMatchObject({ kind: 'repo', rel: '' })
    expect(overview.folders[1]?.repos).toEqual([
      expect.objectContaining({
        kind: 'refused',
        reason: expect.stringMatching(/shown under its own granted folder/) as unknown,
      }),
    ])
  })

  it('uses the app’s own empty file and hooks folder (Windows’ mode) with the hostile repository', async () => {
    const guard = new PathGuard({ roots: () => [grant] })
    const emptyDir = join(base, 'app-empty')
    const app = createGitService({
      guard,
      emit: () => undefined,
      openUrl: () => Promise.resolve(),
      emptyMode: 'app',
      emptyDir,
    })
    // A planted hook in the hooks folder is cleared before git runs.
    mkdirSync(join(emptyDir, 'no-hooks'), { recursive: true })
    writeFileSync(join(emptyDir, 'no-hooks', 'post-index-change'), '#!/bin/sh\nexit 0\n')
    const status = okStatus(await app.status(ref('hostile')))
    expect(status.changes.find((c) => c.path === 'a.txt')).toBeDefined()
    expect(readdirSync(join(emptyDir, 'no-hooks'))).toEqual([])
    text(await app.diff({ repo: ref('hostile'), area: 'unstaged', path: 'a.txt' }))
    expect(await app.log({ repo: ref('hostile'), skip: 0 })).toMatchObject({ ok: true })
    expect(marked()).toEqual([])
  })

  it('accepts a worktree whose .git pointer has trailing spaces, and watches its git folder', async () => {
    const main = join(grant, 'wt-main')
    mkdirSync(main)
    git(main, 'init', '-q')
    writeFileSync(join(main, 'f.txt'), '1\n')
    git(main, 'add', '.')
    git(main, 'commit', '-q', '-m', 'one')
    git(main, 'worktree', 'add', '-q', join(grant, 'wt'))
    const pointer = join(grant, 'wt', '.git')
    const original = readFileSync(pointer, 'utf8')
    writeFileSync(pointer, `${original.trimEnd()}   \n`)
    expect(await service.status(ref('wt'))).toMatchObject({ ok: true, branch: { head: 'wt' } })
    writeFileSync(pointer, original)

    const guard = new PathGuard({ roots: () => [grant] })
    const changes: string[] = []
    const watching = createGitService({
      guard,
      emit: (change) => changes.push(change.rel),
      openUrl: () => Promise.resolve(),
      emptyDir: join(base, 'git-empty-watch'),
    })
    try {
      await watching.watch([ref('wt')])
      // Staging changes only the worktree's git folder (outside the top folder on Linux).
      writeFileSync(join(main, 'unrelated.txt'), 'x\n')
      mkdirSync(join(grant, 'wt', 'sub'))
      writeFileSync(join(grant, 'wt', 'sub', 'g.txt'), 'x\n')
      await new Promise((resolve) => setTimeout(resolve, 700))
      changes.length = 0
      git(join(grant, 'wt'), 'add', 'sub/g.txt')
      await expect.poll(() => changes, { timeout: 5000 }).toContain('wt')
    } finally {
      watching.close()
    }
  })

  // The reviewer's scenario: any Windows user can create C:\dev\null. A config planted
  // there must never be read. Only on CI, where the machine is thrown away.
  it.runIf(platform === 'win32' && process.env['CI'] && !existsSync('C:\\dev'))(
    'ignores a config planted at C:\\dev\\null',
    async () => {
      const fsmonitor = writeScript(
        'planted.sh',
        `echo hit > "${slash(join(markers, 'planted'))}"\nexit 1`,
      )
      mkdirSync('C:\\dev')
      try {
        writeFileSync('C:\\dev\\null', `[core]\n\tfsmonitor = ${fsmonitor}\n`)
        okStatus(await service.status(ref('hostile')))
        expect(marked()).toEqual([])
      } finally {
        rmSync('C:\\dev', { recursive: true, force: true })
      }
    },
  )

  it('never created a marker', () => {
    expect(marked()).toEqual([])
  })
})
