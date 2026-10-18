import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PathGuard } from '../permissions/guard'
import { makeSandbox, put, trySymlink, type Sandbox } from '../permissions/test-support'
import { MAX_TREE_CHECK_MS, MAX_TREE_ENTRIES, assertNoBlockedInside, walk } from './walk'

let sb: Sandbox
let guard: PathGuard

beforeEach(async () => {
  sb = await makeSandbox()
  guard = new PathGuard({ roots: () => [sb.root] })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await sb.cleanup()
})

describe('walk', () => {
  it('does not descend into a folder swapped for a link after it was listed', async () => {
    await put(path.join(sb.root, 'a', 'inside.txt'), 'x')
    await put(path.join(sb.outside, 'secret.txt'), 's')
    const errors: string[] = []
    const seen: string[] = []
    const signal = new AbortController().signal
    for await (const entry of walk(sb.root, guard, {
      maxDepth: 5,
      signal,
      onError: (p, reason) => errors.push(`${path.basename(p)}: ${reason}`),
    })) {
      seen.push(entry.rel)
      if (entry.rel === 'a') {
        // Between listing `a` and descending into it, replace it with a link out of the grant.
        await fs.rename(path.join(sb.root, 'a'), path.join(sb.root, 'a-moved'))
        expect(await trySymlink(sb.outside, path.join(sb.root, 'a'), 'dir')).toBe(true)
      }
    }
    expect(seen).not.toContain('a/secret.txt')
    expect(errors).toEqual(['a: no longer a folder'])
  })

  it('does not descend into a folder replaced by another real folder', async () => {
    await put(path.join(sb.root, 'a', 'inside.txt'), 'x')
    const errors: string[] = []
    for await (const entry of walk(sb.root, guard, {
      maxDepth: 5,
      signal: new AbortController().signal,
      onError: (p, reason) => errors.push(`${path.basename(p)}: ${reason}`),
    })) {
      if (entry.rel === 'a') {
        await fs.rename(path.join(sb.root, 'a'), path.join(sb.root, 'a-moved'))
        await put(path.join(sb.root, 'a', 'planted.txt'), 'p')
      }
    }
    expect(errors).toEqual(['a: replaced while listing'])
  })
})

describe('walk and grants', () => {
  it('stops yielding as soon as the grant is revoked mid-walk', async () => {
    await put(path.join(sb.root, 'a', 'inside.txt'))
    await put(path.join(sb.root, 'b.txt'))
    await put(path.join(sb.root, 'c', 'deep', 'd.txt'))
    let roots = [sb.root]
    const revocable = new PathGuard({ roots: () => roots })
    const seen: string[] = []
    const errors: string[] = []
    for await (const entry of walk(sb.root, revocable, {
      maxDepth: 5,
      signal: new AbortController().signal,
      onError: (_p, reason) => errors.push(reason),
    })) {
      seen.push(entry.rel)
      if (seen.length === 1) roots = []
    }
    expect(seen).toEqual(['a'])
    expect(errors[0]).toMatch(/no longer allowed|no longer inside a granted folder/)
  })

  it('re-checks the guard for each folder before listing it', async () => {
    await put(path.join(sb.root, 'a', 'inside.txt'))
    let roots = [sb.root]
    const revocable = new PathGuard({ roots: () => roots })
    const errors: string[] = []
    const seen: string[] = []
    const entries = walk(sb.root, revocable, {
      maxDepth: 5,
      signal: new AbortController().signal,
      onError: (_p, reason) => errors.push(reason),
    })
    for await (const entry of entries) {
      seen.push(entry.rel)
      // Revoke just before the walk descends into `a`, keeping `a` itself in the
      // lexical list so only the full guard check can catch it.
      if (entry.rel === 'a') roots = [path.join(sb.root, 'a', 'nonexistent-subgrant')]
    }
    expect(seen).toEqual(['a'])
    expect(errors).toEqual([expect.stringMatching(/^no longer allowed/)])
  })
})

describe('assertNoBlockedInside', () => {
  const signal = new AbortController().signal

  it('passes a clean folder and refuses one with a protected file', async () => {
    await put(path.join(sb.root, 'clean', 'a.txt'))
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'clean'), guard, 100, signal),
    ).resolves.toEqual({ entries: 1 })
    await put(path.join(sb.root, 'dirty', 'deep', '.env'))
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'dirty'), guard, 100, signal),
    ).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringMatching(/contains a protected item/) as unknown,
    })
  })

  it('fails closed when a subfolder cannot be listed', async () => {
    await put(path.join(sb.root, 'dir', 'sub', 'a.txt'))
    const realReaddir = fs.readdir.bind(fs)
    vi.spyOn(fs, 'readdir').mockImplementation(((p: string) =>
      p.endsWith('sub')
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        : realReaddir(p)) as typeof fs.readdir)
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'dir'), guard, 100, signal),
    ).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringMatching(/Could not check everything.*EACCES/) as unknown,
    })
  })

  it('fails closed when an entry cannot be stat-ed', async () => {
    await put(path.join(sb.root, 'dir', 'a.txt'))
    const realLstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(((p: string, o?: object) =>
      p.endsWith('a.txt')
        ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        : realLstat(p, o)) as typeof fs.lstat)
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'dir'), guard, 100, signal),
    ).rejects.toMatchObject({ message: expect.stringMatching(/EBUSY/) as unknown })
  })

  it('refuses a folder with a hard-linked file anywhere inside', async () => {
    await put(path.join(sb.outside, 'secret.txt'), 's')
    await put(path.join(sb.root, 'proj', 'src', 'a.ts'), 'a')
    await fs.link(
      path.join(sb.outside, 'secret.txt'),
      path.join(sb.root, 'proj', 'src', 'deep.txt'),
    )
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'proj'), guard, 100, signal),
    ).rejects.toMatchObject({
      code: 'hard-link',
      message: expect.stringMatching(/deep\.txt/) as unknown,
    })
  })

  it('refuses folders over the entry limit, and cancelled scans', async () => {
    for (const n of ['a', 'b', 'c']) await put(path.join(sb.root, 'big', n))
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'big'), guard, 2, signal),
    ).rejects.toMatchObject({
      code: 'too-large',
      message: expect.stringMatching(/more than 2 entries/) as unknown,
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'big'), guard, 100, aborted.signal),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('counts a real tree of thousands of entries exactly, in a streaming walk', async () => {
    const big = path.join(sb.root, 'big')
    for (let d = 0; d < 20; d++) {
      const dir = path.join(big, `d${String(d)}`, 'nested')
      await fs.mkdir(dir, { recursive: true })
      await Promise.all(
        Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(dir, `f${String(i)}`), '')),
      )
    }
    // 20 top folders + 20 nested folders + 2000 files.
    await expect(assertNoBlockedInside(big, guard, MAX_TREE_ENTRIES, signal)).resolves.toEqual({
      entries: 2040,
    })
    await put(path.join(big, 'd19', 'nested', 'zz', '.env'))
    await expect(assertNoBlockedInside(big, guard, MAX_TREE_ENTRIES, signal)).rejects.toMatchObject(
      { code: 'protected' },
    )
    // Real disk I/O: 2,000 file creates and two full walks take 2-5 s on Windows CI runners.
  }, 30_000)

  it('allows folders far beyond the old 100,000-entry cap', async () => {
    // A synthetic folder: the listing, lstat and handle checks of its children are faked so
    // the test stays fast; everything else (walk, guard, limits) is the real code.
    const big = path.join(sb.root, 'big')
    await fs.mkdir(big)
    const size = 150_000
    const names = Array.from({ length: size }, (_, i) => `f${String(i).padStart(6, '0')}`)
    const fake = (ino: bigint) => ({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true,
      size: 0n,
      mtimeMs: 0n,
      nlink: 1n,
      dev: 1n,
      ino,
    })
    const inoOf = (p: string) => BigInt(path.basename(p).slice(1)) + 1_000_000n
    const realReaddir = fs.readdir.bind(fs)
    const realLstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'readdir').mockImplementation(((p: string) =>
      p === big ? Promise.resolve([...names]) : realReaddir(p)) as typeof fs.readdir)
    vi.spyOn(fs, 'lstat').mockImplementation(((p: string, o?: object) =>
      path.dirname(p) === big
        ? Promise.resolve(fake(inoOf(p)))
        : realLstat(p, o)) as typeof fs.lstat)
    vi.spyOn(fs, 'open').mockImplementation(((p: string) =>
      Promise.resolve({
        stat: () => Promise.resolve(fake(inoOf(p))),
        close: () => Promise.resolve(),
      })) as unknown as typeof fs.open)

    expect(MAX_TREE_ENTRIES).toBeGreaterThan(size)
    await expect(assertNoBlockedInside(big, guard, MAX_TREE_ENTRIES, signal)).resolves.toEqual({
      entries: size,
    })
    await expect(assertNoBlockedInside(big, guard, size - 1, signal)).rejects.toMatchObject({
      code: 'too-large',
      message: expect.stringMatching(/more than 149,999 entries/) as unknown,
    })
  }, 30_000)

  it('stops at the wall-clock budget with a helpful message', async () => {
    for (let i = 0; i < 20; i++) await put(path.join(sb.root, 'slow', `f${String(i)}`))
    let t = 0
    const budget = { ms: MAX_TREE_CHECK_MS, now: () => (t += 10_000) }
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'slow'), guard, MAX_TREE_ENTRIES, signal, budget),
    ).rejects.toMatchObject({
      code: 'too-large',
      message: expect.stringMatching(
        /stopped after 60 s \(\d+ entries checked so far\).*subfolders one at a time/,
      ) as unknown,
    })
  })

  it('never stats a protected or ungranted entry', async () => {
    await put(path.join(sb.root, 'dir', 'a.txt'))
    await put(path.join(sb.root, 'dir', '.env'))
    const statted: string[] = []
    const realLstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(((p: string, o?: object) => {
      statted.push(path.basename(p))
      return realLstat(p, o)
    }) as typeof fs.lstat)
    const blocked: string[] = []
    for await (const _ of walk(path.join(sb.root, 'dir'), guard, {
      maxDepth: 1,
      signal,
      onBlocked: (p) => blocked.push(path.basename(p)),
    })) {
      // drain
    }
    expect(blocked).toEqual(['.env'])
    expect(statted).toContain('a.txt')
    expect(statted).not.toContain('.env')
  })
})
