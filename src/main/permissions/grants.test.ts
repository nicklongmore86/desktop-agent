import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GrantStore } from './grants'
import { makeSandbox, put, trySymlink, type Sandbox } from './test-support'

describe('GrantStore', () => {
  let sb: Sandbox
  let file: string

  beforeEach(async () => {
    sb = await makeSandbox()
    file = path.join(sb.userData, 'grants.json')
  })

  afterEach(async () => {
    await sb.cleanup()
  })

  it('starts empty when there is no file', async () => {
    const store = await GrantStore.open(file)
    expect(store.list()).toEqual([])
    expect(store.loadError).toBeNull()
  })

  it('adds, lists, persists and removes grants', async () => {
    const store = await GrantStore.open(file, { protectedPaths: [sb.userData] })
    expect(await store.add(sb.root)).toEqual({ ok: true, root: sb.root })
    expect(store.list()).toEqual([sb.root])

    const saved: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(saved).toEqual({ version: 1, roots: [sb.root] })

    const reopened = await GrantStore.open(file)
    expect(reopened.list()).toEqual([sb.root])

    expect(await reopened.remove(sb.root)).toBe(true)
    expect(reopened.list()).toEqual([])
    expect(await reopened.remove(sb.root)).toBe(false)
    expect((await GrantStore.open(file)).list()).toEqual([])
  })

  it('gives each grant a token, new each time the folder is granted again', async () => {
    await fs.writeFile(file, JSON.stringify({ version: 1, roots: [sb.root] }))
    const store = await GrantStore.open(file)
    const loaded = store.token(sb.root)
    expect(loaded).toMatch(/^[0-9a-f-]{36}$/)
    await store.add(sb.root)
    expect(store.token(sb.root)).toBe(loaded)
    expect(store.token(path.join(sb.root, 'sub'))).toBeNull()
    await store.remove(sb.root)
    expect(store.token(sb.root)).toBeNull()
    await store.add(sb.root)
    const regranted = store.token(sb.root)
    expect(regranted).toMatch(/^[0-9a-f-]{36}$/)
    expect(regranted).not.toBe(loaded)
    // Another store (the app started again) has tokens of its own.
    expect((await GrantStore.open(file)).token(sb.root)).not.toBe(regranted)
  })

  it('does not add the same folder twice', async () => {
    const store = await GrantStore.open(file)
    await store.add(sb.root)
    await store.add(path.join(sb.root, '.', 'x', '..'))
    expect(store.list()).toEqual([sb.root])
  })

  it('stores the real path of a linked folder', async () => {
    const link = path.join(sb.base, 'link-to-root')
    expect(await trySymlink(sb.root, link, 'dir')).toBe(true)
    const store = await GrantStore.open(file)
    expect(await store.add(link)).toEqual({ ok: true, root: sb.root })
  })

  it('refuses missing folders, files, roots, blocked and protected folders', async () => {
    const store = await GrantStore.open(file, { protectedPaths: [sb.userData] })
    expect(await store.add(path.join(sb.base, 'missing'))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/does not exist/) as unknown,
    })
    await put(path.join(sb.root, 'file.txt'))
    expect(await store.add(path.join(sb.root, 'file.txt'))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a folder/) as unknown,
    })
    expect(await store.add(path.parse(sb.root).root)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/root/) as unknown,
    })
    await fs.mkdir(path.join(sb.root, '.ssh'))
    expect(await store.add(path.join(sb.root, '.ssh'))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/blocked/) as unknown,
    })
    expect(await store.add(sb.userData)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/app's own data/) as unknown,
    })
    expect(await store.add('relative/folder')).toMatchObject({ ok: false })
    expect(store.list()).toEqual([])
  })

  it('fails closed on a corrupt file and leaves it alone', async () => {
    await put(file, '{ not json')
    const store = await GrantStore.open(file)
    expect(store.list()).toEqual([])
    expect(store.loadError).toMatch(/Could not read/)
    expect(await fs.readFile(file, 'utf8')).toBe('{ not json')

    await put(file, JSON.stringify({ version: 1, roots: [1, 2] }))
    const wrongShape = await GrantStore.open(file)
    expect(wrongShape.list()).toEqual([])
    expect(wrongShape.loadError).toMatch(/not a valid grants file/)
  })

  it('removes Windows grants case-insensitively', async () => {
    await put(file, JSON.stringify({ version: 1, roots: ['C:\\Users\\Me\\Projects'] }))
    const store = await GrantStore.open(file, { platform: 'win32' })
    expect(await store.remove('c:\\users\\me\\PROJECTS')).toBe(true)
    expect(store.list()).toEqual([])
  })
})
