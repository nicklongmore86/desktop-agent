// A click on a file named in a reply, on the real file system of the OS running the tests.
// The `win32` block is Windows-only and does not skip there: real NTFS case folding, junctions,
// 8.3 aliases, alternate data streams and shortcut and program files. Nothing launches: the
// shell is a mock, and the tests prove it is never asked to open a blocked type.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PathGuard } from '../permissions/guard'
import {
  ensureWindowsShortPath,
  makeSandbox,
  MemoryAudit,
  put,
  trySymlink,
  type Sandbox,
} from '../permissions/test-support'
import { openMention } from './mention'

let box: Sandbox
let guard: PathGuard
const open = vi.fn((_path: string) => Promise.resolve(''))
const reveal = vi.fn((_path: string) => {})
let audit: MemoryAudit

beforeEach(async () => {
  open.mockClear()
  reveal.mockClear()
  audit = new MemoryAudit()
  box = await makeSandbox()
  guard = new PathGuard({ roots: () => [box.root], protectedPaths: [box.userData] })
  await put(path.join(box.root, 'Notes.txt'), 'notes\n')
  await put(path.join(box.root, 'sub', 'deep.md'), '# deep\n')
  await put(path.join(box.root, 'setup.exe'), 'MZ')
  await put(path.join(box.root, 'shortcut.lnk'), 'L')
  await put(path.join(box.root, 'macro.docm'), 'PK')
  await put(path.join(box.root, '.env'), 'TOKEN=1\n')
  await put(path.join(box.outside, 'private.txt'), 'outside\n')
  await put(path.join(box.userData, 'audit.jsonl'), '{}\n')
})

afterEach(async () => {
  await box.cleanup()
})

const click = (text: string) => openMention(guard, text, { open, reveal, audit })
const at = (...names: string[]) => path.join(box.root, ...names)

describe('a click on a file named in a reply, on the real file system', () => {
  it('opens an allowed file and a folder, and writes the audit entries', async () => {
    expect(await click(at('Notes.txt'))).toMatchObject({ ok: true, action: 'open' })
    expect(await click(at('sub'))).toMatchObject({ ok: true, action: 'open' })
    expect(await click('sub/deep.md')).toMatchObject({ ok: true, action: 'open' })
    expect(open.mock.calls.map(([p]) => p)).toEqual([
      at('Notes.txt'),
      at('sub'),
      at('sub', 'deep.md'),
    ])
    expect(audit.entries).toHaveLength(3)
    expect(audit.entries[0]).toMatchObject({
      tool: 'open_from_reply',
      args: { action: 'open', kind: 'file' },
      paths: [at('Notes.txt')],
      outcome: 'ok',
    })
  })

  it('shows a program, a shortcut and a macro file in Explorer and never opens them', async () => {
    for (const name of ['setup.exe', 'shortcut.lnk', 'macro.docm'])
      expect(await click(at(name))).toMatchObject({ ok: true, action: 'reveal' })
    expect(open).not.toHaveBeenCalled()
    expect(reveal.mock.calls.map(([p]) => p)).toEqual([
      at('setup.exe'),
      at('shortcut.lnk'),
      at('macro.docm'),
    ])
  })

  it('refuses what is outside the grants, secret, blocklisted or missing', async () => {
    for (const text of [
      path.join(box.outside, 'private.txt'),
      path.join(box.userData, 'audit.jsonl'),
      at('.env'),
      at('missing.txt'),
    ])
      expect(await click(text)).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('does not follow a junction or symlink out of the grant', async () => {
    // Folder links are junctions on Windows: no privilege needed, so this never skips there.
    expect(await trySymlink(box.outside, at('escape'), 'dir')).toBe(true)
    expect(await click(at('escape', 'private.txt'))).toMatchObject({ ok: false })
    expect(await click(at('escape'))).toMatchObject({ ok: false })
    expect(await click('escape/private.txt')).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('refuses a file with other hard links', async () => {
    await fs.link(at('Notes.txt'), path.join(box.outside, 'twin.txt'))
    expect(await click(at('Notes.txt'))).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })
})

describe.runIf(process.platform === 'win32')('on Windows (NTFS)', () => {
  it('matches case variants and acts on the real name', async () => {
    const lower = at('NOTES.TXT').toLowerCase()
    expect(await click(lower)).toMatchObject({ ok: true, action: 'open' })
    expect(open).toHaveBeenCalledWith(at('Notes.txt'))
    expect(await click(at('SETUP.EXE'))).toMatchObject({ ok: true, action: 'reveal' })
    expect(await click(at('Shortcut.LNK'))).toMatchObject({ ok: true, action: 'reveal' })
    expect(open).toHaveBeenCalledOnce()
  })

  it('refuses a trailing dot or space, which Windows would strip', async () => {
    for (const text of [`${at('Notes.txt')}.`, `${at('Notes.txt')} `, `${at('setup.exe')}.`])
      expect(await click(text)).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('refuses alternate data stream syntax, for a stream that exists too', async () => {
    await fs.writeFile(`${at('Notes.txt')}:evil`, 'hidden stream')
    for (const text of [
      `${at('Notes.txt')}:evil`,
      `${at('Notes.txt')}::$DATA`,
      `${at('Notes.txt')}:evil:$DATA`,
      `${at('sub')}:evil`,
    ])
      expect(await click(text)).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses an 8.3 short name, for a file and for a folder', async () => {
    const shortFile = ensureWindowsShortPath(at('Notes.txt'), 'NOTES~1.TXT')
    const shortFolder = ensureWindowsShortPath(at('sub'), 'SUB~1')
    if (shortFile === null || shortFolder === null) return // not on Windows CI: it throws there
    expect(shortFile.toLowerCase()).not.toBe(at('Notes.txt').toLowerCase())
    expect(await click(shortFile)).toMatchObject({ ok: false })
    expect(await click(path.join(shortFolder, 'deep.md'))).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses network and device paths', async () => {
    for (const text of ['\\\\localhost\\c$\\Windows\\win.ini', `\\\\?\\${at('Notes.txt')}`])
      expect(await click(text)).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })
})
