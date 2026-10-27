import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GrantStore } from '../permissions/grants'
import { makeSandbox, put, trySymlink, type Sandbox } from '../permissions/test-support'
import {
  CACHE_FORMAT,
  DocumentTextCache,
  entryName,
  grantId,
  parseEntry,
  type CachedText,
  type DocumentFileKey,
} from './document-text-cache'

let sb: Sandbox
let dir: string
let roots: string[]

beforeEach(async () => {
  sb = await makeSandbox()
  dir = path.join(sb.userData, 'document-text-cache')
  roots = [sb.root]
})

afterEach(async () => {
  await sb.cleanup()
})

const text = (words: string, extra: Partial<CachedText> = {}): CachedText => ({
  kind: 'pdf',
  segments: [{ at: 'page 1', text: words }],
  scanned: false,
  blankPages: 0,
  truncated: null,
  failure: null,
  ...extra,
})

const key = (overrides: Partial<DocumentFileKey> = {}): DocumentFileKey => ({
  root: sb.root,
  dev: 2049n,
  ino: 1234567n,
  size: 5000n,
  mtimeNs: 1_700_000_000_123_456_789n,
  ctimeNs: 1_700_000_000_123_456_789n,
  ...overrides,
})

/** The token every granted root has here (GrantStore's are tested with the store). */
const T = 'grant-token'
const granted = { list: () => roots, token: (root: string) => (roots.includes(root) ? T : null) }

const open = (options: Partial<ConstructorParameters<typeof DocumentTextCache>[0]> = {}) =>
  new DocumentTextCache({ dir, grants: granted, ...options })

async function filesUnder(folder: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      out.push(path.relative(folder, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    }
  }
  return out.sort()
}

describe('DocumentTextCache', () => {
  it('keeps an entry under its grant folder and reads it back', async () => {
    const cache = open()
    expect(await cache.put(key(), text('Walk-In Freezer'), T)).toBe(true)
    expect(cache.has(key())).toBe(true)
    expect(await cache.get(key())).toEqual(text('Walk-In Freezer'))
    expect(await filesUnder(dir)).toEqual([`${grantId(sb.root)}/${entryName(key())}`])
    // Hash names only: nothing of the path or the text in a file name.
    expect(grantId(sb.root)).toMatch(/^[0-9a-f]{32}$/)
    expect(entryName(key())).toMatch(/^[0-9a-f]{64}\.json$/)
    // A new instance finds it on disk.
    const again = open()
    await again.load()
    expect(again.has(key())).toBe(true)
    expect(await again.get(key())).toEqual(text('Walk-In Freezer'))
  })

  it.each([
    ['size', { size: 5001n }],
    ['mtime', { mtimeNs: 1_700_000_000_123_456_790n }],
    ['ctime', { ctimeNs: 1_700_000_001_000_000_000n }],
    ['inode', { ino: 7654321n }],
    ['device', { dev: 2050n }],
  ] as const)('misses when the file’s %s changed', async (_what, change) => {
    const cache = open()
    await cache.put(key(), text('old text'), T)
    expect(cache.has(key(change))).toBe(false)
    expect(await cache.get(key(change))).toBeNull()
    expect(await cache.get(key())).toEqual(text('old text'))
  })

  it('keys by grant: the same file under another grant misses', async () => {
    const other = path.join(sb.base, 'other')
    await fs.mkdir(other)
    roots = [sb.root, other]
    const cache = open()
    await cache.put(key(), text('a'), T)
    expect(await cache.get(key({ root: other }))).toBeNull()
  })

  it('folds case of Windows grant paths, and not of POSIX ones', () => {
    expect(grantId('C:\\Users\\Ada\\Jobs', 'win32')).toBe(grantId('c:\\users\\ada\\JOBS', 'win32'))
    expect(grantId('/home/ada/Jobs', 'linux')).not.toBe(grantId('/home/ada/jobs', 'linux'))
  })

  it('writes nothing for a folder that is not granted', async () => {
    const cache = open()
    expect(await cache.put(key({ root: sb.outside }), text('x'), T)).toBe(false)
    await expect(fs.readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('makes its folders and entries owner-only', async () => {
    const cache = open()
    await cache.put(key(), text('x'), T)
    const folder = path.join(dir, grantId(sb.root))
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(folder)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(folder, entryName(key())))).mode & 0o777).toBe(0o600)
  })

  it('evicts the least recently used entries past the total limit', async () => {
    let now = 1_000_000
    const body = 'x'.repeat(1000)
    // Every entry here has the same size: room for three.
    const probe = open({ dir: path.join(sb.base, 'probe') })
    await probe.put(key(), text(body), T)
    const size = probe.usage().bytes
    const cache = open({ maxTotalBytes: size * 3 + 10, clock: () => (now += 1000) })
    for (const ino of [1000001n, 1000002n, 1000003n]) await cache.put(key({ ino }), text(body), T)
    expect(cache.usage().entries).toBe(3)
    // Using 1 makes 2 the oldest.
    expect(await cache.get(key({ ino: 1000001n }))).not.toBeNull()
    await cache.put(key({ ino: 1000004n }), text(body), T)
    expect([1000001n, 1000002n, 1000003n, 1000004n].map((ino) => cache.has(key({ ino })))).toEqual([
      true,
      false,
      true,
      true,
    ])
    expect(cache.usage().bytes).toBe(size * 3)
    expect(await filesUnder(dir)).toHaveLength(3)
  })

  it('evicts by entry count, and never keeps an entry over the per-entry limit', async () => {
    const cache = open({ maxEntries: 2, maxEntryBytes: 600 })
    expect(await cache.put(key({ ino: 1n }), text('a'), T)).toBe(true)
    expect(await cache.put(key({ ino: 2n }), text('b'), T)).toBe(true)
    expect(await cache.put(key({ ino: 3n }), text('c'), T)).toBe(true)
    expect(cache.usage().entries).toBe(2)
    expect(cache.has(key({ ino: 1n }))).toBe(false)
    expect(await cache.put(key({ ino: 4n }), text('y'.repeat(700)), T)).toBe(false)
    expect(cache.has(key({ ino: 4n }))).toBe(false)
  })

  it('evicts down to the limits on load', async () => {
    const big = open()
    for (const ino of [1n, 2n, 3n]) await big.put(key({ ino }), text('x'.repeat(1000)), T)
    const small = open({ maxTotalBytes: (big.usage().bytes / 3) * 2 + 10 })
    await small.load()
    expect(small.usage().entries).toBe(2)
    expect(await filesUnder(dir)).toHaveLength(2)
  })

  it('deletes a grant’s folder when it is forgotten, and leaves the others', async () => {
    const other = path.join(sb.base, 'other')
    await fs.mkdir(other)
    roots = [sb.root, other]
    const cache = open()
    await cache.put(key(), text('a'), T)
    await cache.put(key({ root: other }), text('b'), T)
    await cache.forgetGrant(sb.root)
    expect(cache.has(key())).toBe(false)
    expect(await fs.readdir(dir)).toEqual([grantId(other)])
    expect(await cache.get(key({ root: other }))).toEqual(text('b'))
  })

  it('is deleted when the grant store removes the grant (the app’s wiring)', async () => {
    const grants = await GrantStore.open(path.join(sb.userData, 'grants.json'))
    await grants.add(sb.root)
    const cache = new DocumentTextCache({ dir, grants })
    grants.onRemove((root) => cache.forgetGrant(root))
    await cache.put(key(), text('a'), grants.token(sb.root) ?? '')
    expect(await fs.readdir(dir)).toEqual([grantId(sb.root)])
    await grants.remove(sb.root)
    expect(await fs.readdir(dir)).toEqual([])
    expect(cache.has(key())).toBe(false)
  })

  it('writes nothing under a token from before the grant was removed and granted again', async () => {
    const grants = await GrantStore.open(path.join(sb.userData, 'grants.json'))
    await grants.add(sb.root)
    const cache = new DocumentTextCache({ dir, grants })
    grants.onRemove((root) => cache.forgetGrant(root))
    const stale = cache.token(sb.root) ?? ''
    await grants.remove(sb.root)
    await grants.add(sb.root)
    expect(await cache.put(key(), text('old grant'), stale)).toBe(false)
    expect(cache.has(key())).toBe(false)
    expect(await fs.readdir(dir).catch(() => [])).toEqual([])
    // Under the new grant's own token it is kept.
    expect(await cache.put(key(), text('new grant'), cache.token(sb.root) ?? '')).toBe(true)
    expect(await cache.get(key())).toEqual(text('new grant'))
  })

  it('deletes an entry whose grant changed between its write and its rename', async () => {
    let asked = 0
    // The second question is the one after the rename: by then the grant is a new one.
    const cache = open({
      grants: {
        list: () => roots,
        token: () => (++asked === 2 ? 'regranted' : T),
      },
    })
    expect(await cache.put(key(), text('a'), T)).toBe(false)
    expect(asked).toBe(2)
    expect(cache.has(key())).toBe(false)
    expect(await filesUnder(dir)).toEqual([])
  })

  it('deletes on load the folders of grants removed while the app was closed, and junk', async () => {
    const other = path.join(sb.base, 'other')
    await fs.mkdir(other)
    roots = [sb.root, other]
    const before = open()
    await before.put(key(), text('a'), T)
    await before.put(key({ root: other }), text('b'), T)
    const folder = path.join(dir, grantId(sb.root))
    await put(path.join(folder, 'abc.tmp'), 'half written')
    await put(path.join(folder, 'notes.txt'), 'junk')
    await put(path.join(dir, 'stray.json'), 'junk')
    await fs.mkdir(path.join(folder, `${'0'.repeat(64)}.json`))

    roots = [sb.root]
    const after = open()
    await after.load()
    expect(await filesUnder(dir)).toEqual([`${grantId(sb.root)}/${entryName(key())}`])
    expect(await after.get(key())).toEqual(text('a'))
  })

  it('never follows a link planted in the cache', async () => {
    const outsideFile = path.join(sb.outside, 'victim.txt')
    await put(outsideFile, 'keep me')
    const cache = open()
    await cache.put(key(), text('a'), T)
    const entry = path.join(dir, grantId(sb.root), entryName(key()))
    await fs.rm(entry)
    if (!(await trySymlink(outsideFile, entry, 'file'))) return
    expect(await cache.get(key())).toBeNull()
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('keep me')
    // A linked grant folder is removed (the link, not its target) on the next load.
    await fs.rm(path.join(dir, grantId(sb.root)), { recursive: true })
    expect(await trySymlink(sb.outside, path.join(dir, grantId(sb.root)), 'dir')).toBe(true)
    const again = open()
    await again.load()
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('keep me')
    expect(await fs.readdir(dir)).toEqual([])
    expect(await again.put(key(), text('b'), T)).toBe(true)
    expect(await fs.readdir(sb.outside)).toEqual(['victim.txt'])
  })

  it('treats what it reads back as untrusted: anything but its own entry is dropped', async () => {
    const cache = open()
    await cache.put(key(), text('a'), T)
    const file = path.join(dir, grantId(sb.root), entryName(key()))
    const good = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    const bad: unknown[] = [
      'not json',
      { ...good, format: CACHE_FORMAT + 1 },
      { ...good, grant: grantId(sb.outside) },
      { ...good, file: { ...(good['file'] as object), size: '5001' } },
      { ...good, file: { ...(good['file'] as object), mtimeNs: '-1' } },
      { ...good, kind: '../../etc' },
      { ...good, extra: true },
      { ...good, segments: [{ at: 'page 1', text: 1 }] },
      { ...good, segments: [{ at: 'x'.repeat(301), text: 'a' }] },
      { ...good, segments: [{ at: '', text: 'a', offset: -4 }] },
      { ...good, segments: [{ at: '', text: 'a', cells: 'yes' }] },
      { ...good, segments: [{ at: '', text: 'a', script: 'x' }] },
      { ...good, failure: 'Not A Code' },
      { ...good, scanned: 'no' },
      { ...good, blankPages: -1 },
      { ...good, blankPages: undefined },
    ]
    for (const value of bad) {
      await put(file, typeof value === 'string' ? value : JSON.stringify(value))
      const fresh = open()
      await fresh.load()
      expect(fresh.has(key())).toBe(true)
      expect(await fresh.get(key())).toBeNull()
      // Dropped from disk too, so it is not read again.
      await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('refuses an entry grown past the per-entry limit on disk', async () => {
    const cache = open({ maxEntryBytes: 4096 })
    await cache.put(key(), text('a'), T)
    const file = path.join(dir, grantId(sb.root), entryName(key()))
    await fs.appendFile(file, ' '.repeat(5000))
    expect(await cache.get(key())).toBeNull()
  })

  it('parses only what it wrote, with the key checked field by field', () => {
    const raw = (value: unknown) => Buffer.from(JSON.stringify(value))
    const file = {
      dev: '2049',
      ino: '1234567',
      size: '5000',
      mtimeNs: '1700000000123456789',
      ctimeNs: '1700000000123456789',
    }
    const entry = { format: CACHE_FORMAT, grant: 'g', file, ...text('hi') }
    expect(parseEntry(raw(entry), 'g', key())).toEqual(text('hi'))
    expect(parseEntry(raw(entry), 'h', key())).toBeNull()
    expect(parseEntry(raw({ ...entry, file: { ...file, ino: '01234567' } }), 'g', key())).toBeNull()
  })
})
