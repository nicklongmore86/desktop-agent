// The decision behind a click on a file or folder named in a reply, on an in-memory Windows
// tree (case-insensitive, junctions, 8.3 aliases) so the Windows rules run on every OS.
// The same rules run on the real file system in mention-real.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { MentionOpenResult } from '../../shared/ipc-files'
import type { GuardFs } from '../permissions/guard'
import { PathGuard } from '../permissions/guard'
import { MemoryAudit } from '../permissions/test-support'
import { classifyName, decideMention, OPEN_EXTENSIONS, openMention } from './mention'
import { createFilesService } from './service'
import { fakeWindowsTree } from './test-support'

const ROOT = 'C:\\Users\\Me\\Projects'
const OTHER = 'C:\\Users\\Me\\Other'
const OUTSIDE = 'C:\\Users\\Me\\Private'
const USER_DATA = 'C:\\Users\\Me\\AppData\\Roaming\\Desktop Agent'

const BLOCKED_NAMES = [
  'setup.exe',
  'run.bat',
  'run.cmd',
  'script.ps1',
  'shortcut.lnk',
  'link.url',
  'saver.scr',
  'install.msi',
  'code.js',
  'code.vbs',
  'page.hta',
  'tool.jar',
  'macro.docm',
  'macro.xlsm',
  'macro.pptm',
  'old.xls',
  'old.doc',
  'old.ppt',
  'picture.svg',
  'page.html',
  'data.bin',
  'README',
  'archive.zip',
  'notes.txt.exe',
  'NOTES.TXT.LNK',
  'doc.txt\u200b',
  '.txt',
]
const OPEN_NAMES = [
  'Notes.txt',
  'Read.MD',
  'data.csv',
  'a.LOG',
  'r.PDF',
  'p.png',
  'p.JPEG',
  'm.docx',
]

function setup(extra: { files?: string[]; links?: Record<string, string> } = {}) {
  const files: Record<string, { size?: number; nlink?: number }> = {}
  for (const name of [...BLOCKED_NAMES, ...OPEN_NAMES, ...(extra.files ?? []), 'secrets.json'])
    files[`${ROOT}\\${name}`] = { size: 1 }
  files[`${ROOT}\\Notes.txt`] = { size: 1 }
  // Names Windows cannot store, so only the name rules can refuse them.
  files[`${ROOT}\\trail.txt.`] = { size: 1 }
  files[`${ROOT}\\trail2.txt `] = { size: 1 }
  files[`${ROOT}\\hard.txt`] = { size: 1, nlink: 2 }
  files[`${ROOT}\\.env`] = { size: 1 }
  files[`${ROOT}\\sub\\deep.md`] = { size: 1 }
  files[`${ROOT}\\Other\\only-here.txt`] = { size: 1 }
  files[`${OTHER}\\twin.txt`] = { size: 1 }
  files[`${ROOT}\\twin.txt`] = { size: 1 }
  // The same relative paths in two granted folders (only ambiguous once OTHER is granted).
  for (const base of [ROOT, OTHER]) {
    files[`${base}\\report.md`] = { size: 1 }
    files[`${base}\\docs\\report.md`] = { size: 1 }
  }
  files[`${OUTSIDE}\\private.txt`] = { size: 1 }
  files[`${USER_DATA}\\audit.jsonl`] = { size: 1 }
  const tree = fakeWindowsTree({
    dirs: [
      'C:\\Users',
      'C:\\Users\\Me',
      ROOT,
      `${ROOT}\\sub`,
      `${ROOT}\\docs`,
      `${OTHER}\\docs`,
      `${ROOT}\\Other`,
      `${ROOT}\\evil.exe`,
      OTHER,
      OUTSIDE,
      USER_DATA,
    ],
    files,
    links: { [`${ROOT}\\escape`]: OUTSIDE, ...extra.links },
    shortNames: {
      [`${ROOT}\\NOTES~1.TXT`]: `${ROOT}\\Notes.txt`,
      [`${ROOT}\\SUB~1`]: `${ROOT}\\sub`,
    },
  })
  const realpaths: string[] = []
  const guardFs: GuardFs = {
    ...tree.guardFs,
    realpath: (p) => {
      realpaths.push(p)
      return tree.guardFs.realpath(p)
    },
  }
  const roots = [ROOT]
  const guard = new PathGuard({
    roots: () => roots,
    platform: 'win32',
    fs: guardFs,
    protectedPaths: [USER_DATA],
  })
  const shell = {
    open: vi.fn((_path: string) => Promise.resolve('')),
    reveal: vi.fn((_path: string) => {}),
  }
  const audit = new MemoryAudit()
  return { guard, tree, shell, audit, roots, realpaths }
}

async function click(env: ReturnType<typeof setup>, text: string): Promise<MentionOpenResult> {
  return openMention(env.guard, text, { ...env.shell, audit: env.audit }, env.tree.listFs)
}

describe('the allowlist', () => {
  it('has only passive document, text and image types', () => {
    expect([...OPEN_EXTENSIONS].sort()).toEqual(
      [
        'bmp',
        'csv',
        'docx',
        'gif',
        'jpeg',
        'jpg',
        'log',
        'md',
        'odp',
        'ods',
        'odt',
        'pdf',
        'png',
        'pptx',
        'tsv',
        'txt',
        'webp',
        'xlsx',
      ].sort(),
    )
    for (const unsafe of [
      'exe',
      'bat',
      'cmd',
      'ps1',
      'lnk',
      'url',
      'scr',
      'msi',
      'js',
      'vbs',
      'hta',
      'jar',
      'docm',
      'xlsm',
      'pptm',
      'xls',
      'doc',
      'ppt',
      'svg',
      'html',
      'rtf',
    ])
      expect(OPEN_EXTENSIONS.has(unsafe)).toBe(false)
  })

  it.each(OPEN_NAMES)('%s is opened', (name) => {
    expect(classifyName(name, 'win32')).toEqual({ action: 'open' })
  })

  it.each([
    ...BLOCKED_NAMES,
    'invoice\u202Efdp.exe',
    'a.txt.',
    'a.txt ',
    'a.txt:evil',
    'a.txt::$DATA',
  ])('%j is never opened', (name) => {
    const how = classifyName(name, 'win32')
    expect('action' in how ? how.action : 'refused').not.toBe('open')
  })
})

describe('a click on a file or folder named in a reply', () => {
  it.each(BLOCKED_NAMES)('%j is shown in Explorer and never launched', async (name) => {
    const env = setup()
    const result = await click(env, `${ROOT}\\${name}`)
    expect(result).toMatchObject({ ok: true, action: 'reveal' })
    expect(result.ok && result.note).toMatch(/not opened/)
    expect(env.shell.open).not.toHaveBeenCalled()
    expect(env.shell.reveal).toHaveBeenCalledOnce()
  })

  it.each(OPEN_NAMES)('%s is opened with its default app', async (name) => {
    const env = setup()
    expect(await click(env, `${ROOT}\\${name}`)).toMatchObject({ ok: true, action: 'open' })
    expect(env.shell.open).toHaveBeenCalledWith(`${ROOT}\\${name}`)
    expect(env.shell.reveal).not.toHaveBeenCalled()
  })

  it('opens a folder in Explorer, even one named like a program', async () => {
    const env = setup()
    expect(await click(env, `${ROOT}\\sub`)).toMatchObject({ ok: true, action: 'open' })
    expect(await click(env, `${ROOT}\\evil.exe`)).toMatchObject({ ok: true, action: 'open' })
    expect(await click(env, ROOT)).toMatchObject({ ok: true, action: 'open' })
    expect(env.shell.open.mock.calls.map(([p]) => p)).toEqual([
      `${ROOT}\\sub`,
      `${ROOT}\\evil.exe`,
      ROOT,
    ])
  })

  it('matches case variants and acts on the real name', async () => {
    const env = setup()
    // `Notes.txt` is stored; the reply spells it any way. The decision uses the real name.
    for (const text of [
      `c:\\users\\me\\projects\\NOTES.TXT`,
      `C:/Users/Me/Projects/notes.txt`,
      `C:\\USERS\\ME\\PROJECTS\\Notes.TXT`,
    ]) {
      expect(await decideMention(env.guard, text, env.tree.listFs)).toEqual({
        ok: true,
        path: `${ROOT}\\Notes.txt`,
        kind: 'file',
        action: 'open',
      })
    }
    // The extension comes from the real name: `NOTES.TXT.LNK` is stored, so it is revealed
    // however the reply spells it.
    expect(await decideMention(env.guard, `${ROOT}\\notes.txt.lnk`, env.tree.listFs)).toMatchObject(
      { ok: true, action: 'reveal' },
    )
  })

  it.each([
    `${ROOT}\\Notes.txt.`,
    `${ROOT}\\Notes.txt `,
    `${ROOT}\\Notes.txt..`,
    `${ROOT}\\trail.txt.`,
    `${ROOT}\\trail2.txt `,
    `${ROOT}\\Notes.txt:evil`,
    `${ROOT}\\Notes.txt::$DATA`,
    `${ROOT}\\Notes.txt:evil:$DATA`,
    `${ROOT}\\Notes.txt:evil:42`,
    'Notes.txt.',
    'Notes.txt:evil',
    `${ROOT}\\sub.`,
  ])('refuses the odd name %j', async (text) => {
    const env = setup()
    expect(await click(env, text)).toMatchObject({ ok: false })
    expect(env.shell.open).not.toHaveBeenCalled()
    expect(env.shell.reveal).not.toHaveBeenCalled()
  })

  it('reads a trailing :line or :line:column as a line number, not a stream', async () => {
    const env = setup()
    for (const text of [`${ROOT}\\Notes.txt:42`, `${ROOT}\\Notes.txt:42:7`, 'Notes.txt:3'])
      expect(await decideMention(env.guard, text, env.tree.listFs)).toMatchObject({
        ok: true,
        path: `${ROOT}\\Notes.txt`,
      })
  })

  it.each([
    ['an 8.3 short name', `${ROOT}\\NOTES~1.TXT`],
    ['an 8.3 short folder name', `${ROOT}\\SUB~1\\deep.md`],
    ['a junction out of the grant', `${ROOT}\\escape\\private.txt`],
    ['the junction itself', `${ROOT}\\escape`],
    ['a path outside every grant', `${OUTSIDE}\\private.txt`],
    ['the app data folder', `${USER_DATA}\\audit.jsonl`],
    ['a UNC path', '\\\\server\\share\\a.txt'],
    ['a UNC path with forward slashes', '//server/share/a.txt'],
    ['a device path', '\\\\?\\C:\\Users\\Me\\Projects\\Notes.txt'],
    ['a parent segment', `${ROOT}\\sub\\..\\Notes.txt`],
    ['a path that climbs out', `${ROOT}\\..\\Private\\private.txt`],
    ['a relative parent segment', '..\\Private\\private.txt'],
    ['a drive-relative path', 'C:Notes.txt'],
    ['a rooted path without a drive', '\\Users\\Me\\Projects\\Notes.txt'],
    ['a secret file', `${ROOT}\\secrets.json`],
    ['a blocklisted file', `${ROOT}\\.env`],
    ['a hard-linked file', `${ROOT}\\hard.txt`],
    ['a file that does not exist', `${ROOT}\\missing.txt`],
    ['a reserved device name', `${ROOT}\\NUL.txt`],
    ['text with a control character', `${ROOT}\\Notes\u0007.txt`],
    ['text with a bidi override', `${ROOT}\\Notes\u202E.txt`],
    ['text with a quote', `${ROOT}\\"Notes.txt`],
    ['empty text', ''],
    ['a web address', 'https://example.com/a.txt'],
  ])('refuses %s', async (_name, text) => {
    const env = setup()
    expect(await click(env, text)).toMatchObject({ ok: false })
    expect(env.shell.open).not.toHaveBeenCalled()
    expect(env.shell.reveal).not.toHaveBeenCalled()
  })

  it('never touches the file system outside the grants', async () => {
    const env = setup()
    for (const text of [
      `${OUTSIDE}\\private.txt`,
      'C:\\Windows\\System32\\cmd.exe',
      `${USER_DATA}\\audit.jsonl`,
      'D:\\anything.txt',
    ])
      await decideMention(env.guard, text, env.tree.listFs)
    // Paths outside the grants (the app data folder is outside them too) are rejected as text.
    expect(env.realpaths).toEqual([])
    expect(env.tree.lstats).toEqual([])
  })

  it('answers every refusal the same way, so a reply cannot tell them apart', async () => {
    const env = setup()
    const answers = await Promise.all(
      [
        `${ROOT}\\secrets.json`,
        `${ROOT}\\.env`,
        `${ROOT}\\missing.txt`,
        `${OUTSIDE}\\private.txt`,
      ].map(async (text) => {
        const { resolveMentions } = await import('./mention')
        return resolveMentions(env.guard, [text], env.tree.listFs)
      }),
    )
    expect(answers).toEqual([[{ ok: false }], [{ ok: false }], [{ ok: false }], [{ ok: false }]])
  })

  it('re-checks the current grants at click time', async () => {
    const env = setup()
    const before = await decideMention(env.guard, `${ROOT}\\Notes.txt`, env.tree.listFs)
    expect(before.ok).toBe(true)
    env.roots.length = 0
    expect(await click(env, `${ROOT}\\Notes.txt`)).toMatchObject({ ok: false })
    expect(env.shell.open).not.toHaveBeenCalled()
  })

  it('resolves a relative path against the granted folders', async () => {
    const env = setup()
    for (const text of [
      'Notes.txt',
      './Notes.txt',
      'sub/deep.md',
      'sub\\deep.md',
      'Projects/sub/deep.md',
      'sub/',
    ])
      expect(await decideMention(env.guard, text, env.tree.listFs)).toMatchObject({ ok: true })
    expect(await decideMention(env.guard, 'sub/', env.tree.listFs)).toMatchObject({
      kind: 'dir',
    })
    expect(await decideMention(env.guard, 'nothing/here.txt', env.tree.listFs)).toMatchObject({
      ok: false,
    })
  })

  it('does not guess when a relative name exists in two granted folders', async () => {
    const env = setup()
    env.roots.push(OTHER)
    expect(await decideMention(env.guard, 'twin.txt', env.tree.listFs)).toMatchObject({
      ok: false,
    })
    expect(await decideMention(env.guard, `${OTHER}\\twin.txt`, env.tree.listFs)).toMatchObject({
      ok: true,
      path: `${OTHER}\\twin.txt`,
    })
  })

  it('stays plain, in resolve and in open, when one relative path is in two granted folders', async () => {
    const env = setup()
    env.roots.push(OTHER)
    for (const text of ['report.md', 'docs/report.md', './docs\\report.md']) {
      expect(await decideMention(env.guard, text, env.tree.listFs)).toMatchObject({ ok: false })
      expect(await click(env, text)).toMatchObject({ ok: false })
    }
    expect(env.shell.open).not.toHaveBeenCalled()
    expect(env.shell.reveal).not.toHaveBeenCalled()
    // Granting only one of them makes the same text unambiguous again.
    env.roots.splice(0, env.roots.length, OTHER)
    expect(await decideMention(env.guard, 'report.md', env.tree.listFs)).toMatchObject({
      ok: true,
      path: `${OTHER}\\report.md`,
    })
  })

  it('surfaces the error openPath returns, and records the failure', async () => {
    const env = setup()
    env.shell.open.mockResolvedValueOnce('No application is associated with the file.')
    const result = await click(env, `${ROOT}\\Notes.txt`)
    expect(result).toEqual({
      ok: false,
      reason: 'Windows could not open it: No application is associated with the file.',
    })
    expect(env.audit.entries.at(-1)).toMatchObject({ outcome: 'error', error: 'open-failed' })
  })

  it('writes one audit entry per attempt, with action, path and result and no contents', async () => {
    const env = setup()
    await click(env, `${ROOT}\\Notes.txt`)
    await click(env, `${ROOT}\\setup.exe`)
    await click(env, `${ROOT}\\sub`)
    await click(env, `${ROOT}\\secrets.json`)
    expect(env.audit.entries).toHaveLength(4)
    expect(
      env.audit.entries.map(({ args, paths, outcome, error, origin, tool }) => ({
        args,
        paths,
        outcome,
        error,
        origin,
        tool,
      })),
    ).toEqual([
      {
        tool: 'open_from_reply',
        origin: 'user',
        args: { action: 'open', kind: 'file' },
        paths: [`${ROOT}\\Notes.txt`],
        outcome: 'ok',
        error: undefined,
      },
      {
        tool: 'open_from_reply',
        origin: 'user',
        args: { action: 'reveal', kind: 'file' },
        paths: [`${ROOT}\\setup.exe`],
        outcome: 'ok',
        error: undefined,
      },
      {
        tool: 'open_from_reply',
        origin: 'user',
        args: { action: 'open', kind: 'dir' },
        paths: [`${ROOT}\\sub`],
        outcome: 'ok',
        error: undefined,
      },
      {
        tool: 'open_from_reply',
        origin: 'user',
        args: { action: 'refused' },
        paths: [],
        outcome: 'error',
        error: 'refused',
      },
    ])
  })

  it('is wired into the files service', async () => {
    const env = setup()
    const open = vi.fn((_path: string) => Promise.resolve(''))
    const files = createFilesService({
      guard: env.guard,
      reveal: env.shell.reveal,
      open,
      audit: env.audit,
      copyText: () => Promise.resolve(),
      emit: () => {},
      fs: env.tree.listFs,
      watch: () => ({ close: () => {} }),
    })
    expect(
      await files.resolveMentions([`${ROOT}\\Notes.txt`, `${ROOT}\\setup.exe`, 'nope']),
    ).toEqual([
      { ok: true, path: `${ROOT}\\Notes.txt`, kind: 'file', action: 'open' },
      expect.objectContaining({ ok: true, action: 'reveal', kind: 'file' }),
      { ok: false },
    ])
    expect(open).not.toHaveBeenCalled()
    await files.openMention(`${ROOT}\\setup.exe`)
    expect(open).not.toHaveBeenCalled()
    expect(env.shell.reveal).toHaveBeenCalledWith(`${ROOT}\\setup.exe`)
  })
})
