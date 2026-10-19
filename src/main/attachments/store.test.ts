import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exists, makeSandbox, put, trySymlink, type Sandbox } from '../permissions/test-support'
import { AttachmentStore, isAttachmentId } from './store'

let box: Sandbox
let store: AttachmentStore

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

beforeEach(async () => {
  box = await makeSandbox()
  store = new AttachmentStore(path.join(box.userData, 'attachments'))
})

afterEach(async () => {
  await box.cleanup()
})

const FORGED_IDS = [
  '',
  '..',
  '../victim',
  '..\\victim',
  '/etc/passwd',
  'C:\\Windows\\win.ini',
  'A'.repeat(64),
  'a'.repeat(63),
  'a'.repeat(65),
  `${'a'.repeat(64)}/..`,
  `${'a'.repeat(64)}\0`,
  `${'a'.repeat(62)}..`,
]

describe('AttachmentStore', () => {
  it('stores bytes under their sha256, owner-only on POSIX', async () => {
    const id = await store.put(Buffer.from('hello'))
    expect(id).toBe(sha('hello'))
    expect(isAttachmentId(id)).toBe(true)
    const file = path.join(store.dir, id)
    expect(await fs.readFile(file, 'utf8')).toBe('hello')
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(store.dir)).mode & 0o777).toBe(0o700)
    }
    expect(await store.has(id)).toBe(true)
    expect((await store.read(id))?.toString()).toBe('hello')
  })

  it('keeps one file per content, leaves no temp files, and survives concurrent puts', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => store.put(Buffer.from('same'))))
    expect(new Set(ids)).toEqual(new Set([sha('same')]))
    expect(await fs.readdir(store.dir)).toEqual([sha('same')])
  })

  it('refuses forged ids before joining any path', async () => {
    await put(path.join(box.userData, 'victim'), 'keep me')
    await put(path.join(store.dir, 'placeholder'), 'x')
    for (const id of FORGED_IDS) {
      expect(isAttachmentId(id)).toBe(false)
      expect(await store.has(id)).toBe(false)
      expect(await store.read(id)).toBeNull()
    }
    await store.release(FORGED_IDS)
    expect(await fs.readFile(path.join(box.userData, 'victim'), 'utf8')).toBe('keep me')
    expect(await exists(path.join(store.dir, 'placeholder'))).toBe(true)
  })

  it('a crash before the rename leaves no blob under the id', async () => {
    const id = sha('partial')
    // What a crash mid-write leaves behind: a temp file only.
    await put(path.join(store.dir, `.${id}.0000.tmp`), 'part')
    expect(await store.has(id)).toBe(false)
    expect(await store.read(id)).toBeNull()
    expect(await store.put(Buffer.from('partial'))).toBe(id)
    expect((await store.read(id))?.toString()).toBe('partial')
  })

  it('does not return a blob whose content no longer matches its id', async () => {
    const id = await store.put(Buffer.from('original'))
    await fs.chmod(path.join(store.dir, id), 0o600)
    await fs.writeFile(path.join(store.dir, id), 'tampered')
    expect(await store.read(id)).toBeNull()
  })

  it('does not follow a link planted under a valid id', async () => {
    await put(path.join(box.outside, 'secret.txt'), 'outside')
    const id = sha('outside')
    await fs.mkdir(store.dir, { recursive: true })
    if (!(await trySymlink(path.join(box.outside, 'secret.txt'), path.join(store.dir, id), 'file')))
      return
    expect(await store.has(id)).toBe(false)
    expect(await store.read(id)).toBeNull()
  })

  it('shares one blob between identical attachments, so release removes it for all', async () => {
    // The same screenshot attached in two chats.
    const inChatA = await store.put(Buffer.from('same screenshot'))
    const inChatB = await store.put(Buffer.from('same screenshot'))
    expect(inChatA).toBe(inChatB)
    expect(await fs.readdir(store.dir)).toEqual([inChatA])
    // Chat A is deleted and releases its id: chat B's attachment is gone too. This is why
    // callers must only release ids that no saved chat references.
    await store.release([inChatA])
    expect(await store.has(inChatB)).toBe(false)
    expect(await store.read(inChatB)).toBeNull()
  })

  it('releases valid ids only', async () => {
    const a = await store.put(Buffer.from('a'))
    const b = await store.put(Buffer.from('b'))
    await store.release([a, '../b'])
    expect(await store.has(a)).toBe(false)
    expect(await store.has(b)).toBe(true)
  })

  it('sweeps unreferenced old blobs and stale temp files, and nothing else', async () => {
    const kept = await store.put(Buffer.from('kept'))
    const old = await store.put(Buffer.from('old'))
    const young = await store.put(Buffer.from('young'))
    await put(path.join(store.dir, `.${old}.1234.tmp`), 'x')
    await put(path.join(store.dir, 'notes.txt'), 'not ours')
    const past = new Date(Date.now() - 60_000)
    for (const name of [kept, old, `.${old}.1234.tmp`, 'notes.txt'])
      await fs.utimes(path.join(store.dir, name), past, past)

    const removed = await store.sweep((id) => id === kept, 30_000)
    expect(removed).toEqual([old])
    expect((await fs.readdir(store.dir)).sort()).toEqual([kept, 'notes.txt', young].sort())
  })

  it('sweeping a store that was never written is a no-op', async () => {
    expect(await store.sweep(() => false, 0)).toEqual([])
  })
})
