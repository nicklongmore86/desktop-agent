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
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
      'C:\\Tools\\git.exe',
      'C:\\Users\\me\\Downloads\\repo\\git.exe',
    ])
  })

  it('never uses a git inside a granted folder', async () => {
    const found = await findGit({
      platform: 'win32',
      env: { Path: 'C:\\Users\\me\\Downloads\\repo;C:\\Tools' },
      grantedRoots: () => ['C:\\Users\\me\\Downloads'],
      isFile: (path) => Promise.resolve(path !== 'C:\\Program Files\\Git\\cmd\\git.exe'),
    })
    expect(found).toBe('C:\\Tools\\git.exe')
  })

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
