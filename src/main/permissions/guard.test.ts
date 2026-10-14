import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathGuard, type Resolution } from './guard'
import {
  fakeWindowsFs,
  makeSandbox,
  put,
  trySymlink,
  ensureWindowsShortPath,
  type Sandbox,
} from './test-support'

function expectAllowed(r: Resolution): { path: string; root: string; exists: boolean } {
  if (!r.ok) throw new Error(`expected allowed, got: ${r.reason}`)
  return r
}

function expectDenied(r: Resolution, reason?: RegExp): void {
  expect(r.ok).toBe(false)
  if (!r.ok && reason) expect(r.reason).toMatch(reason)
}

describe('PathGuard on the real file system', () => {
  let sb: Sandbox
  let guard: PathGuard

  beforeEach(async () => {
    sb = await makeSandbox()
    guard = new PathGuard({ roots: () => [sb.root], protectedPaths: [sb.userData] })
  })

  afterEach(async () => {
    await sb.cleanup()
  })

  it('allows existing and not-yet-existing paths inside a grant', async () => {
    await put(path.join(sb.root, 'notes.txt'), 'hi')
    const existing = expectAllowed(await guard.resolve(path.join(sb.root, 'notes.txt')))
    expect(existing).toMatchObject({
      path: path.join(sb.root, 'notes.txt'),
      root: sb.root,
      exists: true,
    })

    const fresh = expectAllowed(await guard.resolve(path.join(sb.root, 'new', 'deep', 'file.md')))
    expect(fresh).toMatchObject({
      path: path.join(sb.root, 'new', 'deep', 'file.md'),
      root: sb.root,
      exists: false,
    })

    expect(expectAllowed(await guard.resolve(sb.root)).exists).toBe(true)
  })

  it('rejects ../ traversal out of the grant', async () => {
    await put(path.join(sb.outside, 'secret.txt'), 'x')
    expectDenied(
      await guard.resolve(path.join(sb.root, '..', 'outside', 'secret.txt')),
      /outside the granted/,
    )
    expectDenied(
      await guard.resolve(`${sb.root}${path.sep}..${path.sep}outside`),
      /outside the granted/,
    )
    // `..` that stays inside is fine.
    expectAllowed(await guard.resolve(path.join(sb.root, 'a', '..', 'b.txt')))
  })

  it('rejects sibling folders that share the root as a name prefix', async () => {
    await fs.mkdir(`${sb.root}-evil`)
    expectDenied(await guard.resolve(path.join(`${sb.root}-evil`, 'x.txt')), /outside the granted/)
  })

  it('rejects relative paths and NUL characters', async () => {
    expectDenied(await guard.resolve('notes.txt'), /absolute/)
    expectDenied(await guard.resolve(path.join(sb.root, 'a\0b')), /NUL/)
  })

  it('rejects a folder link that points out of the grant', async () => {
    await put(path.join(sb.outside, 'secret.txt'), 'x')
    const link = path.join(sb.root, 'escape')
    expect(await trySymlink(sb.outside, link, 'dir')).toBe(true)
    expectDenied(await guard.resolve(path.join(link, 'secret.txt')), /outside the granted/)
    expectDenied(await guard.resolve(path.join(link, 'not-yet.txt')), /outside the granted/)
    expectDenied(await guard.resolve(link), /outside the granted/)
  })

  it('rejects a file link that points out of the grant', async (ctx) => {
    await put(path.join(sb.outside, 'secret.txt'), 'x')
    const link = path.join(sb.root, 'innocent.txt')
    if (!(await trySymlink(path.join(sb.outside, 'secret.txt'), link, 'file'))) ctx.skip()
    expectDenied(await guard.resolve(link), /outside the granted/)
  })

  it('rejects a dangling link, which a write would follow out of the grant', async (ctx) => {
    const link = path.join(sb.root, 'dangling.txt')
    if (!(await trySymlink(path.join(sb.outside, 'created-by-write.txt'), link, 'file'))) ctx.skip()
    expectDenied(await guard.resolve(link), /target does not exist/)
    expectDenied(await guard.resolve(path.join(link, 'child')), /target does not exist/)
  })

  it('resolves links within the grant to their real target', async (ctx) => {
    await put(path.join(sb.root, 'real', 'file.txt'), 'x')
    const link = path.join(sb.root, 'alias')
    if (!(await trySymlink(path.join(sb.root, 'real'), link, 'dir'))) ctx.skip()
    const r = expectAllowed(await guard.resolve(path.join(link, 'file.txt')))
    expect(r.path).toBe(path.join(sb.root, 'real', 'file.txt'))
  })

  it('with followFinalSymlink false, resolves the link itself, not its target', async () => {
    const link = path.join(sb.root, 'escape')
    expect(await trySymlink(sb.outside, link, 'dir')).toBe(true)
    const r = expectAllowed(await guard.resolve(link, { followFinalSymlink: false }))
    expect(r).toMatchObject({ path: link, root: sb.root, exists: true })
    // ...but links earlier in the path are still followed.
    expectDenied(
      await guard.resolve(path.join(link, 'x'), { followFinalSymlink: false }),
      /outside the granted/,
    )
  })

  it('blocks blocklisted names inside a grant, in any case', async () => {
    await put(path.join(sb.root, '.env'), 'SECRET=1')
    await put(path.join(sb.root, '.ssh', 'id_ed25519'), 'key')
    for (const rel of [
      '.env',
      '.ENV',
      '.env.local',
      '.ssh',
      '.ssh/id_ed25519',
      'sub/server.pem',
      'ID_RSA',
      '.git-credentials',
    ]) {
      expectDenied(await guard.resolve(path.join(sb.root, ...rel.split('/'))), /blocked/)
    }
  })

  it('blocks a link inside the grant that points at a blocklisted file', async (ctx) => {
    await put(path.join(sb.root, '.env'), 'SECRET=1')
    const link = path.join(sb.root, 'notes.txt')
    if (!(await trySymlink(path.join(sb.root, '.env'), link, 'file'))) ctx.skip()
    expectDenied(await guard.resolve(link), /blocked/)
  })

  it("blocks the app's own data even when a grant covers it", async () => {
    const wide = new PathGuard({ roots: () => [sb.base], protectedPaths: [sb.userData] })
    await put(path.join(sb.userData, 'grants.json'), '{}')
    expectDenied(await wide.resolve(path.join(sb.userData, 'grants.json')), /app's own data/)
    expectDenied(await wide.resolve(path.join(sb.userData, 'audit.jsonl')), /app's own data/)
    expectAllowed(await wide.resolve(path.join(sb.outside, 'fine.txt')))
  })

  it('stops honouring a grant whose folder was replaced by a link', async () => {
    const granted = path.join(sb.base, 'granted')
    await fs.mkdir(granted)
    const swapped = new PathGuard({ roots: () => [granted] })
    expectAllowed(await swapped.resolve(path.join(granted, 'x.txt')))
    await fs.rm(granted, { recursive: true })
    expect(await trySymlink(sb.outside, granted, 'dir')).toBe(true)
    expectDenied(await swapped.resolve(path.join(granted, 'x.txt')), /outside the granted/)
  })

  it.skipIf(process.platform !== 'win32')(
    'expands a real 8.3 short name before the blocklist (Windows only: needs NTFS short names; required on CI)',
    async (ctx) => {
      const secret = path.join(sb.root, '.env.production')
      await put(secret, 'SECRET=1')
      const alias = ensureWindowsShortPath(secret, 'ENVPRO~1.ENV')
      if (alias === null) {
        ctx.skip()
        return
      }
      expectDenied(await guard.resolve(alias), /blocked/)
      expectDenied(await guard.resolve(alias, { followFinalSymlink: false }), /blocked/)
    },
  )

  it('denies everything when nothing is granted', async () => {
    const none = new PathGuard({ roots: () => [] })
    expectDenied(await none.resolve(path.join(sb.root, 'x')), /no folders have been granted/)
  })

  it('reports whether a path is or contains a grant root', () => {
    expect(guard.isRoot(sb.root)).toBe(true)
    expect(guard.isRoot(path.join(sb.root, 'x'))).toBe(false)
    const nested = new PathGuard({ roots: () => [sb.root, path.join(sb.root, 'a', 'b')] })
    expect(nested.containsRoot(path.join(sb.root, 'a'))).toBe(true)
    expect(nested.containsRoot(path.join(sb.root, 'a', 'b'))).toBe(true)
    expect(nested.containsRoot(path.join(sb.root, 'c'))).toBe(false)
  })
})

describe('PathGuard with Windows semantics', () => {
  const fsWin = fakeWindowsFs(
    [
      'C:\\Users',
      'C:\\Users\\Me',
      'C:\\Users\\Me\\Projects',
      'C:\\Users\\Me\\Projects\\notes.txt',
      'C:\\Users\\Me\\Projects\\.env',
      'C:\\Users\\Me\\Projects\\.env.production',
      'C:\\Users\\Me\\Projects\\report-final.docx',
      'C:\\Users\\Me\\.ssh',
      'C:\\Users\\Me\\.ssh\\id_rsa',
      'C:\\Users\\Me\\AppData',
      'C:\\Users\\Me\\AppData\\Roaming',
      'C:\\Users\\Me\\AppData\\Roaming\\Microsoft',
      'C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Credentials',
      'C:\\Users\\Me\\AppData\\Roaming\\Desktop Agent',
      'D:\\Elsewhere',
      'D:\\Elsewhere\\loot.txt',
    ],
    {
      'C:\\Users\\Me\\Projects\\junction': 'D:\\Elsewhere',
      'C:\\Users\\Me\\Projects\\ssh-link': 'C:\\Users\\Me\\.ssh',
      'C:\\Users\\Me\\Projects\\share': '\\\\server\\share',
      'C:\\Users\\Me\\Projects\\broken': 'D:\\Missing\\x',
      'C:\\Users\\Me\\Projects\\Shortcut Link': 'D:\\Elsewhere',
    },
    {
      'C:\\Users\\Me\\Projects\\ENVPRO~1': 'C:\\Users\\Me\\Projects\\.env.production',
      'C:\\Users\\Me\\Projects\\REPORT~1.DOC': 'C:\\Users\\Me\\Projects\\report-final.docx',
      'C:\\Users\\Me\\Projects\\SHORTC~1': 'C:\\Users\\Me\\Projects\\Shortcut Link',
    },
  )
  const guard = new PathGuard({
    roots: () => ['C:\\Users\\Me\\Projects'],
    protectedPaths: ['C:\\Users\\Me\\AppData\\Roaming\\Desktop Agent'],
    platform: 'win32',
    fs: fsWin,
  })
  const homeGuard = new PathGuard({
    roots: () => ['C:\\Users\\Me'],
    protectedPaths: ['C:\\Users\\Me\\AppData\\Roaming\\Desktop Agent'],
    platform: 'win32',
    fs: fsWin,
  })

  it('matches grants case-insensitively and returns the real casing', async () => {
    const r = expectAllowed(await guard.resolve('c:\\USERS\\me\\projects\\NOTES.TXT'))
    expect(r.path).toBe('C:\\Users\\Me\\Projects\\notes.txt')
    expect(r.root).toBe('C:\\Users\\Me\\Projects')
    const fresh = expectAllowed(await guard.resolve('c:/users/me/projects/New Folder/a.txt'))
    expect(fresh.path).toBe('C:\\Users\\Me\\Projects\\New Folder\\a.txt')
    expect(fresh.exists).toBe(false)
  })

  it('rejects traversal, including mixed separators and case', async () => {
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\..\\.ssh\\id_rsa'), /blocked/)
    expectDenied(await guard.resolve('C:/users/me/PROJECTS/../AppData'), /outside the granted/)
    expectDenied(
      await guard.resolve('C:\\Users\\Me\\Projects\\..\\..\\..\\Windows\\System32'),
      /outside/,
    )
  })

  it('rejects junctions out of the grant, and into blocked folders', async () => {
    expectDenied(
      await guard.resolve('C:\\Users\\Me\\Projects\\junction\\loot.txt'),
      /outside the granted/,
    )
    expectDenied(
      await guard.resolve('C:\\Users\\Me\\Projects\\JUNCTION\\new.txt'),
      /outside the granted/,
    )
    expectDenied(await homeGuard.resolve('C:\\Users\\Me\\Projects\\ssh-link\\id_rsa'), /blocked/)
  })

  it('rejects junctions that resolve to network shares', async () => {
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\share\\doc.txt'), /UNC/)
  })

  it('rejects dangling junctions', async () => {
    expectDenied(
      await guard.resolve('C:\\Users\\Me\\Projects\\broken\\file.txt'),
      /target does not exist/,
    )
  })

  it('rejects UNC, device, ADS and reserved-name paths before touching the disk', async () => {
    expectDenied(await guard.resolve('\\\\server\\share\\Projects\\x.txt'), /UNC/)
    expectDenied(await guard.resolve('\\\\?\\C:\\Users\\Me\\Projects\\notes.txt'), /Device/)
    expectDenied(await guard.resolve('\\\\.\\C:\\Users\\Me\\Projects\\notes.txt'), /Device/)
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\notes.txt:hidden'), /alternate data/)
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\notes.txt::$DATA'), /alternate data/)
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\NUL'), /reserved/)
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\com1.txt'), /reserved/)
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\.env.'), /dot or space/)
    expectDenied(await guard.resolve('Projects\\notes.txt'), /drive letter/)
  })

  it('applies the blocklist inside a grant', async () => {
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\.env'), /blocked/)
    expectDenied(await guard.resolve('C:\\Users\\Me\\Projects\\.ENV.Production'), /blocked/)
    expectDenied(await homeGuard.resolve('C:\\Users\\Me\\.SSH\\id_rsa'), /blocked/)
    expectDenied(
      await homeGuard.resolve('C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Credentials\\x'),
      /Windows credentials/,
    )
    expectDenied(
      await homeGuard.resolve('c:\\users\\me\\appdata\\roaming\\desktop agent\\grants.json'),
      /app's own data/,
    )
  })

  it('expands 8.3 short names before the blocklist, including for unfollowed entries', async () => {
    const alias = 'C:\\Users\\Me\\Projects\\ENVPRO~1'
    expectDenied(await guard.resolve(alias), /blocked/)
    expectDenied(await guard.resolve(alias, { followFinalSymlink: false }), /blocked/)
    const doc = expectAllowed(
      await guard.resolve('c:\\users\\me\\projects\\report~1.doc', { followFinalSymlink: false }),
    )
    expect(doc).toMatchObject({ path: 'C:\\Users\\Me\\Projects\\report-final.docx', exists: true })
  })

  it('canonicalizes an unfollowed link by name and refuses short aliases of links', async () => {
    const link = expectAllowed(
      await guard.resolve('C:\\Users\\Me\\Projects\\shortcut link', { followFinalSymlink: false }),
    )
    expect(link).toMatchObject({ path: 'C:\\Users\\Me\\Projects\\Shortcut Link', exists: true })
    expectDenied(
      await guard.resolve('C:\\Users\\Me\\Projects\\SHORTC~1', { followFinalSymlink: false }),
      /short \(8\.3\) or alias name/,
    )
  })

  it('does not match a grant on another drive', async () => {
    expectDenied(await guard.resolve('D:\\Elsewhere\\loot.txt'), /outside the granted/)
  })
})
