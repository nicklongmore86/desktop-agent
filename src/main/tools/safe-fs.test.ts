import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathGuard } from '../permissions/guard'
import { makeSandbox, put, trySymlink, type Sandbox } from '../permissions/test-support'
import { ToolFailure } from './define'
import { hashHandle, openVerified, overwriteHandle, readBounded } from './safe-fs'

let sb: Sandbox
let guard: PathGuard

beforeEach(async () => {
  sb = await makeSandbox()
  guard = new PathGuard({ roots: () => [sb.root] })
})

afterEach(async () => {
  await sb.cleanup()
})

async function failure(promise: Promise<unknown>): Promise<ToolFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ToolFailure) return error
    throw error
  }
  throw new Error('expected a ToolFailure')
}

describe('openVerified', () => {
  it('opens a guarded file and reads, hashes and rewrites it through the handle', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'hello')
    const { handle, stats } = await openVerified(guard, file, 'update')
    try {
      expect(stats.size).toBe(5n)
      expect((await readBounded(handle, 3)).toString()).toBe('hel')
      expect(await hashHandle(handle)).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      )
      await overwriteHandle(handle, Buffer.from('bye'))
    } finally {
      await handle.close()
    }
    expect(await fs.readFile(file, 'utf8')).toBe('bye')
  })

  it('refuses a file whose inode differs from the one that was checked', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'one')
    const checked = await fs.lstat(file, { bigint: true })
    // Replace it with a different file at the same path (the old one stays alive, so its
    // inode number cannot be reused).
    await fs.rename(file, path.join(sb.root, 'old.txt'))
    await put(file, 'two')
    expect((await failure(openVerified(guard, file, 'read', checked))).code).toBe('changed')
  })

  it('refuses files with more than one hard link', async () => {
    await put(path.join(sb.outside, 'secret.txt'), 's')
    await fs.link(path.join(sb.outside, 'secret.txt'), path.join(sb.root, 'alias.txt'))
    const error = await failure(openVerified(guard, path.join(sb.root, 'alias.txt'), 'read'))
    expect(error.code).toBe('hard-link')
  })

  it('refuses to open through a link swapped in after the guard check', async (ctx) => {
    await put(path.join(sb.outside, 'secret.txt'), 's')
    const file = path.join(sb.root, 'a.txt')
    if (!(await trySymlink(path.join(sb.outside, 'secret.txt'), file, 'file'))) ctx.skip()
    expect((await failure(openVerified(guard, file, 'read'))).code).toBe('changed')
  })

  it('re-checks the guard after opening', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'x')
    const revoked = new PathGuard({ roots: () => [] })
    expect((await failure(openVerified(revoked, file, 'read'))).code).toBe('access-denied')
  })

  it('creates exclusively, refusing a path that already exists', async () => {
    const file = path.join(sb.root, 'new.txt')
    const { handle } = await openVerified(guard, file, 'create')
    await handle.close()
    expect((await failure(openVerified(guard, file, 'create'))).code).toBe('changed')
  })
})
