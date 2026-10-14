import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PathGuard } from '../permissions/guard'
import { makeSandbox, put, trySymlink, type Sandbox } from '../permissions/test-support'
import { assertNoBlockedInside, walk } from './walk'

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
    ).resolves.toBeUndefined()
    await put(path.join(sb.root, 'dirty', 'deep', '.env'))
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'dirty'), guard, 100, signal),
    ).rejects.toMatchObject({ code: 'protected', message: /contains a protected item/ })
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
    ).rejects.toMatchObject({ code: 'protected', message: /Could not check everything.*EACCES/ })
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
    ).rejects.toMatchObject({ message: /EBUSY/ })
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
    ).rejects.toMatchObject({ code: 'hard-link', message: /deep\.txt/ })
  })

  it('refuses folders over the entry limit, and cancelled scans', async () => {
    for (const n of ['a', 'b', 'c']) await put(path.join(sb.root, 'big', n))
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'big'), guard, 2, signal),
    ).rejects.toMatchObject({ code: 'too-large' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      assertNoBlockedInside(path.join(sb.root, 'big'), guard, 100, aborted.signal),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })
})
