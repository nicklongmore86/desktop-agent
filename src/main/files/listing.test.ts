import { describe, expect, it, vi } from 'vitest'
import type { FileEntry, FilesListResult } from '../../shared/ipc-files'
import { PathGuard } from '../permissions/guard'
import { referenceFor, withEntryPath } from './actions'
import { listFolder } from './listing'
import { filesRoots, parseRel, resolveLocation, rootId } from './location'
import { isSecretName } from './secret-names'
import { fakeWindowsTree } from './test-support'

// A Windows user profile with one granted folder. Everything here runs on any OS
// through the guard's fake Windows file system (case-insensitive, junctions, 8.3 names).
const HOME = 'C:\\Users\\Me'
const ROOT = `${HOME}\\Projects`
const OUTSIDE = `${HOME}\\Secret`
const APP_DATA = `${ROOT}\\app-data`

function setup(roots: string[] = [ROOT]) {
  let granted = roots
  const tree = fakeWindowsTree({
    dirs: [
      'C:\\Users',
      HOME,
      ROOT,
      `${ROOT}\\src`,
      `${ROOT}\\src\\deep`,
      `${ROOT}\\.ssh`,
      `${ROOT}\\Program Files`,
      APP_DATA,
      OUTSIDE,
    ],
    files: {
      [`${ROOT}\\README.md`]: { size: 120 },
      [`${ROOT}\\b.ts`]: { size: 10 },
      [`${ROOT}\\A.ts`]: { size: 10 },
      [`${ROOT}\\.env`]: {},
      [`${ROOT}\\.env.production`]: {},
      [`${ROOT}\\id_rsa`]: {},
      [`${ROOT}\\server.pem`]: {},
      [`${ROOT}\\secrets.json`]: { size: 5 },
      [`${ROOT}\\linked.txt`]: { size: 5, nlink: 2 },
      [`${ROOT}\\src\\main.ts`]: { size: 30 },
      [`${ROOT}\\.ssh\\id_ed25519`]: {},
      [`${APP_DATA}\\grants.json`]: {},
      [`${OUTSIDE}\\passwords.txt`]: {},
    },
    links: {
      // A junction out of the grant, and one that stays inside it.
      [`${ROOT}\\escape`]: OUTSIDE,
      [`${ROOT}\\shortcut`]: `${ROOT}\\src`,
    },
    shortNames: { [`${ROOT}\\PROGRA~1`]: `${ROOT}\\Program Files` },
  })
  const guard = new PathGuard({
    roots: () => granted,
    protectedPaths: [APP_DATA],
    platform: 'win32',
    fs: tree.guardFs,
  })
  return {
    ...tree,
    guard,
    id: rootId(ROOT),
    revoke: () => {
      granted = []
    },
  }
}

function entries(result: FilesListResult): FileEntry[] {
  if (!result.ok) throw new Error(`expected a listing, got: ${result.reason}`)
  return result.entries
}

const byName = (list: FileEntry[], name: string): FileEntry | undefined =>
  list.find((e) => e.name === name)

describe('files.roots', () => {
  it('gives each granted folder an opaque id, not a path', () => {
    const { guard } = setup([ROOT, 'D:\\Docs'])
    const roots = filesRoots(guard)
    expect(roots.map((r) => r.name)).toEqual(['Projects', 'Docs'])
    expect(roots[0]?.id).toMatch(/^r[0-9a-f]{16}$/)
    expect(roots[0]?.id).not.toContain('Projects')
    expect(new Set(roots.map((r) => r.id)).size).toBe(2)
  })
})

describe('listFolder (fake Windows file system)', () => {
  it('lists one level: folders first, then files, by name ignoring case', async () => {
    const { guard, listFs, id } = setup()
    const list = entries(await listFolder(guard, { rootId: id, rel: '' }, listFs))
    const dirs = list.filter((e) => e.kind === 'dir').map((e) => e.name)
    expect(dirs).toEqual(['Program Files', 'src'])
    const firstFile = list.findIndex((e) => e.kind !== 'dir')
    expect(list.slice(0, firstFile).every((e) => e.kind === 'dir')).toBe(true)
    expect(list.map((e) => e.name).indexOf('A.ts')).toBeLessThan(
      list.map((e) => e.name).indexOf('b.ts'),
    )
    expect(byName(list, 'README.md')).toMatchObject({ rel: 'README.md', kind: 'file', size: 120 })
  })

  it('lists blocklisted names greyed with the reason, and never stats them', async () => {
    const { guard, listFs, id, lstats } = setup()
    const list = entries(await listFolder(guard, { rootId: id, rel: '' }, listFs))
    for (const name of ['.env', '.env.production', 'id_rsa', 'server.pem', '.ssh']) {
      expect(byName(list, name)?.denied, name).toMatch(/blocked/)
      expect(byName(list, name)?.kind).toBe('other')
    }
    // The app's own data is protected even inside a granted folder.
    expect(byName(list, 'app-data')?.denied).toMatch(/app's own data/)
    const stated = lstats.map((p) => p.toLowerCase())
    expect(stated).not.toContain(`${ROOT}\\.env`.toLowerCase())
    expect(stated).not.toContain(`${ROOT}\\.ssh`.toLowerCase())
    expect(stated).not.toContain(APP_DATA.toLowerCase())
  })

  it('refuses to list inside a protected folder', async () => {
    const { guard, listFs, id } = setup()
    const result = await listFolder(guard, { rootId: id, rel: '.ssh' }, listFs)
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/blocked/) as unknown })
  })

  it('flags secret files (display only) and files with other hard links', async () => {
    const { guard, listFs, id } = setup()
    const list = entries(await listFolder(guard, { rootId: id, rel: '' }, listFs))
    expect(byName(list, 'secrets.json')).toMatchObject({ kind: 'file', secret: true })
    expect(byName(list, 'secrets.json')?.denied).toBeUndefined()
    expect(byName(list, 'linked.txt')).toMatchObject({ kind: 'file', hardLink: true })
    expect(byName(list, 'README.md')?.secret).toBeUndefined()
  })

  it('shows junctions as links, says when they leave the grants, and never follows them', async () => {
    const { guard, listFs, id, lstats } = setup()
    const list = entries(await listFolder(guard, { rootId: id, rel: '' }, listFs))
    expect(byName(list, 'escape')).toMatchObject({ kind: 'link', linkOutside: true })
    expect(byName(list, 'shortcut')).toMatchObject({ kind: 'link', linkOutside: false })
    expect(lstats.some((p) => p.toLowerCase().startsWith(OUTSIDE.toLowerCase()))).toBe(false)

    // Listing through either link is refused, even the one that stays inside.
    for (const rel of ['escape', 'shortcut', 'shortcut/deep']) {
      const result = await listFolder(guard, { rootId: id, rel }, listFs)
      expect(result.ok, rel).toBe(false)
    }
    expect(await listFolder(guard, { rootId: id, rel: 'escape' }, listFs)).toMatchObject({
      reason: expect.stringMatching(/outside the granted folders/) as unknown,
    })
  })

  it('refuses 8.3 short names (the real path is not the one asked for)', async () => {
    const { guard, listFs, id } = setup()
    const result = await listFolder(guard, { rootId: id, rel: 'PROGRA~1' }, listFs)
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/link or alias/) as unknown,
    })
    expect(entries(await listFolder(guard, { rootId: id, rel: 'Program Files' }, listFs))).toEqual(
      [],
    )
  })

  it('folds case like NTFS: a differently-cased name lists the same folder', async () => {
    const { guard, listFs, id } = setup()
    const list = entries(await listFolder(guard, { rootId: id, rel: 'SRC' }, listFs))
    expect(list.map((e) => e.name)).toEqual(['deep', 'main.ts'])
  })

  it.each([
    ['..', 'parent'],
    ['src/../..', 'climbing'],
    ['./src', 'dot segment'],
    ['src//deep', 'empty segment'],
    ['/Windows', 'absolute'],
    ['C:/Windows', 'drive'],
    ['src\\deep', 'backslash'],
    ['\\\\?\\C:\\Windows', 'extended-length path'],
    ['\\\\server\\share', 'UNC path'],
    ['README.md:secret', 'alternate data stream'],
    ['nul', 'device name'],
    ['src.', 'trailing dot'],
    ['a\0b', 'NUL'],
  ])('refuses %j (%s)', async (rel) => {
    const { guard, listFs, id } = setup()
    const result = await listFolder(guard, { rootId: id, rel }, listFs)
    expect(result.ok).toBe(false)
  })

  it('refuses an unknown root id and a revoked grant', async () => {
    const { guard, listFs, id, revoke } = setup()
    expect(await listFolder(guard, { rootId: rootId(OUTSIDE), rel: '' }, listFs)).toMatchObject({
      ok: false,
      reason: 'That folder is no longer granted.',
    })
    revoke()
    expect(await listFolder(guard, { rootId: id, rel: '' }, listFs)).toMatchObject({
      ok: false,
      reason: 'That folder is no longer granted.',
    })
  })

  it('caps a huge folder and counts the rest', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
    const tree = fakeWindowsTree({
      dirs: ['C:\\Users', HOME, ROOT],
      files: Object.fromEntries(names.map((n) => [`${ROOT}\\${n}`, {}])),
    })
    const guard = new PathGuard({ roots: () => [ROOT], platform: 'win32', fs: tree.guardFs })
    const result = await listFolder(guard, { rootId: rootId(ROOT), rel: '' }, tree.listFs, 10)
    expect(result).toMatchObject({ ok: true, more: 20 })
    expect(entries(result).map((e) => e.name)).toEqual(names.slice(0, 10))
    // Only the returned entries were stat'ed.
    expect(tree.lstats.length).toBeLessThanOrEqual(11)
  })
})

describe('resolveLocation', () => {
  it('gives the real path of a plain location inside the grant', async () => {
    const { guard, id } = setup()
    expect(await resolveLocation(guard, { rootId: id, rel: 'src/main.ts' })).toMatchObject({
      ok: true,
      path: `${ROOT}\\src\\main.ts`,
      exists: true,
    })
  })

  it('parses relative paths into plain names only', () => {
    expect(parseRel('', 'win32')).toEqual({ ok: true, segments: [] })
    expect(parseRel('a/b c/d.txt', 'win32')).toEqual({ ok: true, segments: ['a', 'b c', 'd.txt'] })
    expect(parseRel('a:b', 'linux')).toEqual({ ok: true, segments: ['a:b'] })
    expect(parseRel('a:b', 'win32').ok).toBe(false)
    expect(parseRel('x'.repeat(5000), 'win32').ok).toBe(false)
  })
})

describe('entry actions', () => {
  it('references a file by its full path, quoted, resolved in main', async () => {
    const { guard, listFs, id } = setup()
    expect(await referenceFor(guard, { rootId: id, rel: 'src/main.ts' }, listFs)).toEqual({
      ok: true,
      text: `@"${ROOT}\\src\\main.ts"`,
    })
    expect(await referenceFor(guard, { rootId: id, rel: 'src' }, listFs)).toEqual({
      ok: true,
      text: `@"${ROOT}\\src"`,
    })
  })

  it('never references blocklisted, secret, hard-linked, linked or outside entries', async () => {
    const { guard, listFs, id } = setup()
    for (const rel of [
      '.env',
      '.ssh/id_ed25519',
      'secrets.json',
      'linked.txt',
      'escape',
      'escape/passwords.txt',
      'shortcut',
      '../Secret/passwords.txt',
      'missing.txt',
    ]) {
      const result = await referenceFor(guard, { rootId: id, rel }, listFs)
      expect(result.ok, rel).toBe(false)
    }
    expect(await referenceFor(guard, { rootId: id, rel: 'secrets.json' }, listFs)).toMatchObject({
      reason: expect.stringMatching(/Secret files/) as unknown,
    })
    expect(await referenceFor(guard, { rootId: id, rel: 'linked.txt' }, listFs)).toMatchObject({
      reason: expect.stringMatching(/hard links/) as unknown,
    })
  })

  it('reveals and copies only checked paths, and passes the real path on', async () => {
    const { guard, listFs, id } = setup()
    const act = vi.fn()
    expect(
      await withEntryPath(guard, { rootId: id, rel: 'SRC/MAIN.TS' }, act, 'refuse', listFs),
    ).toEqual({
      ok: true,
    })
    expect(act).toHaveBeenCalledWith(`${ROOT}\\src\\main.ts`)
    act.mockClear()
    for (const rel of ['escape', '.env', 'PROGRA~1']) {
      expect((await withEntryPath(guard, { rootId: id, rel }, act, 'refuse', listFs)).ok, rel).toBe(
        false,
      )
    }
    expect(act).not.toHaveBeenCalled()
  })
})

describe('isSecretName (panel display policy only)', () => {
  it.each([
    '.env',
    '.ENV.local',
    'prod.env',
    '.envrc',
    'secrets.json',
    'Secrets.YAML',
    'secret.toml',
    'credentials',
    'credentials.json',
    'aws-credentials.csv',
    'service-account-prod.json',
    'terraform.tfvars',
    'prod.tfvars.json',
    'terraform.tfstate',
    'release.keystore',
    '.pgpass',
  ])('%s is secret', (name) => {
    expect(isSecretName(name)).toBe(true)
  })

  it.each(['README.md', 'environment.ts', 'secretary.docx', 'env.d.ts', 'credentialing.md'])(
    '%s is not',
    (name) => {
      expect(isSecretName(name)).toBe(false)
    },
  )
})
