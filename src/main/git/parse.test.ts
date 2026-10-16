import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitCandidates, findGit, parseGitVersion } from './detect'
import { parseLog, parseNumstat, parseStatus } from './queries'
import { redactDiff } from './redact'

describe('parseStatus', () => {
  it('reads the branch, staged, unstaged, renamed, conflicted and untracked entries', () => {
    const out = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 MM N... 100644 100644 100644 aaa bbb src/a b.ts',
      '1 .D N... 100644 100644 000000 aaa aaa gone.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c both.txt',
      '? notes/todo.md',
      '',
    ].join('\0')
    expect(parseStatus(out)).toEqual({
      branch: {
        head: 'feature/x',
        oid: '1234567890abcdef1234567890abcdef12345678',
        upstream: 'origin/feature/x',
        ahead: 2,
        behind: 1,
      },
      changes: [
        { area: 'staged', status: 'modified', path: 'src/a b.ts' },
        { area: 'unstaged', status: 'modified', path: 'src/a b.ts' },
        { area: 'unstaged', status: 'deleted', path: 'gone.txt' },
        { area: 'staged', status: 'renamed', path: 'new name.ts', oldPath: 'old name.ts' },
        { area: 'unstaged', status: 'conflicted', path: 'both.txt' },
        { area: 'untracked', status: 'untracked', path: 'notes/todo.md' },
      ],
    })
  })

  it('knows a detached HEAD and a repository with no commits', () => {
    expect(parseStatus('# branch.oid abc\0# branch.head (detached)\0').branch).toEqual({
      head: null,
      oid: 'abc',
    })
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0').branch).toEqual({
      head: 'main',
      oid: null,
    })
  })

  it('flags names that are not valid text', () => {
    expect(parseStatus('? bad\uFFFDname\0').changes[0]).toMatchObject({ unsafeName: true })
  })
})

describe('parseNumstat', () => {
  it('reads counts, binary files and renames', () => {
    expect(parseNumstat('3\t1\ta.ts\0-\t-\timg.png\x002\t0\t\0old.ts\0new.ts\0')).toEqual([
      { path: 'a.ts', binary: false, additions: 3, deletions: 1 },
      { path: 'img.png', binary: true },
      { path: 'new.ts', binary: false, additions: 2, deletions: 0 },
    ])
  })
})

describe('parseLog', () => {
  it('reads commits, keeping a separator inside the subject', () => {
    const out =
      'a1\x1fa\x1fAda\x1f1700000000\x1fp1 p2\x1fMerge it\0\nb2\x1fb\x1fBob\x1f1600000000\x1fp\x1fodd\x1fsubject\0'
    expect(parseLog(out)).toEqual([
      {
        hash: 'a1',
        short: 'a',
        author: 'Ada',
        date: 1_700_000_000_000,
        subject: 'Merge it',
        merge: true,
      },
      {
        hash: 'b2',
        short: 'b',
        author: 'Bob',
        date: 1_600_000_000_000,
        subject: 'odd\x1fsubject',
        merge: false,
      },
    ])
  })
})

describe('redactDiff', () => {
  it('masks tokens, assignments and private key bodies', () => {
    const diff = [
      '+const key = "sk-abcdefghijklmnop1234"',
      '+password = hunter2',
      '+-----BEGIN RSA PRIVATE KEY-----',
      '+MIIEpAIBAAKCAQEA',
      '+-----END RSA PRIVATE KEY-----',
      ' ordinary line',
    ].join('\n')
    const { text, redacted } = redactDiff(diff)
    expect(redacted).toBe(true)
    expect(text).not.toContain('sk-abcdefghijklmnop1234')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('MIIEpAIBAAKCAQEA')
    expect(text).toContain('+[REDACTED]')
    expect(text).toContain(' ordinary line')
    expect(redactDiff(' plain').redacted).toBe(false)
  })
})

describe('git detection', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: 'C:\\Tools;relative\\bin;\\\\server\\share;C:\\Users\\me\\Downloads\\repo',
  }

  it('looks in the standard Git for Windows folders, then absolute PATH entries only', () => {
    expect(gitCandidates('win32', env)).toEqual([
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\git.exe',
      'C:\\Tools\\git.exe',
      'C:\\Users\\me\\Downloads\\repo\\git.exe',
    ])
  })

  it('never uses a git inside a granted folder', async () => {
    const found = await findGit({
      platform: 'win32',
      env: { Path: 'C:\\Users\\me\\Downloads\\repo;C:\\Tools' },
      grantedRoots: () => ['C:\\Users\\me\\Downloads'],
      isFile: (path) => Promise.resolve(!path.startsWith('C:\\Program Files')),
      realpath: (path) => Promise.resolve(path),
    })
    expect(found).toBe('C:\\Tools\\git.exe')
  })

  it('judges a candidate by its real path: a junction into a granted folder is skipped', async () => {
    const found = await findGit({
      platform: 'win32',
      env: { Path: 'C:\\Tools;C:\\Broken;C:\\Other' },
      grantedRoots: () => ['C:\\Users\\me\\Downloads'],
      isFile: (path) => Promise.resolve(!path.startsWith('C:\\Program Files')),
      realpath: (path) => {
        // C:\Tools is a junction to a downloaded folder; C:\Broken cannot be resolved;
        // C:\Other is a link to a real install, which is what runs.
        if (path.startsWith('C:\\Tools\\'))
          return Promise.resolve('C:\\Users\\me\\Downloads\\repo\\git.exe')
        if (path.startsWith('C:\\Broken\\')) return Promise.reject(new Error('ENOENT'))
        if (path === 'C:\\Other\\git.exe') return Promise.resolve('D:\\Apps\\Git\\cmd\\git.exe')
        return Promise.resolve(path)
      },
    })
    expect(found).toBe('D:\\Apps\\Git\\cmd\\git.exe')
  })

  it('skips a candidate that resolves to a network path', async () => {
    const found = await findGit({
      platform: 'win32',
      env: { Path: 'C:\\Tools' },
      grantedRoots: () => [],
      isFile: (path) => Promise.resolve(!path.startsWith('C:\\Program Files')),
      realpath: (path) =>
        Promise.resolve(path.startsWith('C:\\Tools') ? '\\\\server\\share\\git.exe' : path),
    })
    expect(found).toBeNull()
  })

  it('skips a folder link (a junction on Windows) into a granted folder on the real file system', async () => {
    const windows = process.platform === 'win32'
    const exe = windows ? 'git.exe' : 'git'
    const sep = windows ? ';' : ':'
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-detect-')))
    try {
      const grant = join(base, 'grant')
      const outside = join(base, 'outside')
      mkdirSync(join(grant, 'bin'), { recursive: true })
      mkdirSync(join(outside, 'real'), { recursive: true })
      writeFileSync(join(grant, 'bin', exe), '#!/bin/sh\n')
      writeFileSync(join(outside, 'real', exe), '#!/bin/sh\n')
      // 'junction' makes an NTFS junction on Windows (no admin needed); ignored elsewhere.
      symlinkSync(join(grant, 'bin'), join(outside, 'linkdir'), 'junction')
      symlinkSync(join(outside, 'real'), join(outside, 'goodlink'), 'junction')
      const deps = {
        platform: process.platform,
        grantedRoots: () => [grant],
        // Only this test's folders count (the machine's own git is not looked at).
        isFile: (path: string) => Promise.resolve(path.startsWith(base)),
      }
      expect(await findGit({ ...deps, env: { PATH: join(outside, 'linkdir') } })).toBeNull()
      expect(
        await findGit({
          ...deps,
          env: { PATH: `${join(outside, 'linkdir')}${sep}${join(outside, 'goodlink')}` },
        }),
      ).toBe(join(outside, 'real', exe))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'skips a file symbolic link into a granted folder on the real file system',
    async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-detect-')))
      try {
        const grant = join(base, 'grant')
        mkdirSync(join(grant, 'bin'), { recursive: true })
        mkdirSync(join(base, 'outside'))
        writeFileSync(join(grant, 'bin', 'git'), '#!/bin/sh\n')
        chmodSync(join(grant, 'bin', 'git'), 0o755)
        symlinkSync(join(grant, 'bin', 'git'), join(base, 'outside', 'git'))
        expect(
          await findGit({
            platform: process.platform,
            grantedRoots: () => [grant],
            isFile: (path: string) => Promise.resolve(path.startsWith(base)),
            env: { PATH: join(base, 'outside') },
          }),
        ).toBeNull()
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    },
  )

  it('reports git missing when nothing is found', async () => {
    expect(
      await findGit({
        platform: 'linux',
        env: {},
        grantedRoots: () => [],
        isFile: () => Promise.resolve(false),
      }),
    ).toBeNull()
  })

  it('parses versions', () => {
    expect(parseGitVersion('git version 2.45.1.windows.1\n')).toEqual({
      text: '2.45.1.windows.1',
      major: 2,
      minor: 45,
    })
    expect(parseGitVersion('nope')).toBeNull()
  })
})
