import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS } from '../../shared/attachments'
import {
  attachmentIdsIn,
  createConversationStore,
  isAttachmentName,
  MAX_ATTACHMENT_NAME,
  type AttachmentBlock,
  type StoredMessage,
} from './conversation-store'
import { openHistory, referencedAttachmentIds, titleFrom } from './history-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-attach-'))
  directories.push(path)
  return path
}

const hex = (n: number) => n.toString(16).padStart(64, '0')
const block = (n = 1, extra: Partial<AttachmentBlock> = {}): AttachmentBlock => ({
  type: 'attachment',
  id: hex(n),
  name: `notes-${String(n)}.md`,
  kind: 'text',
  mime: 'text/markdown',
  size: 1200,
  ...extra,
})
const prompt = (text: string, ...attachments: AttachmentBlock[]): StoredMessage => ({
  role: 'user',
  content: [{ type: 'text', text }, ...attachments],
})
const reply = (text: string): StoredMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

async function loads(messages: unknown[]): Promise<boolean> {
  const file = join(await tempDir(), 'c.json')
  await writeFile(file, JSON.stringify({ version: 1, messages }))
  const loaded = await createConversationStore(file).load()
  return loaded.error === null
}

describe('attachment blocks in saved chats', () => {
  it('round-trips a prompt with attachments', async () => {
    const file = join(await tempDir(), 'c.json')
    const messages = [
      prompt('Read these', block(1), block(2, { kind: 'image', mime: 'image/png', size: 9 })),
      reply('Done'),
      { role: 'user' as const, content: [block(3, { kind: 'pdf', mime: 'application/pdf' })] },
    ]
    await createConversationStore(file).save(messages)
    expect(await createConversationStore(file).load()).toEqual({ messages, error: null })
  })

  it('still loads chats saved before attachments existed', async () => {
    expect(await loads([{ role: 'user', content: 'hi' }, reply('hello')])).toBe(true)
  })

  it.each<[string, unknown]>([
    ['an extra field', { ...block(), path: 'C:\\secret.txt' }],
    ['a missing field', (({ mime: _mime, ...rest }) => rest)(block())],
    ['an uppercase id', block(1, { id: hex(1).toUpperCase().replace(/^0/, 'A') })],
    ['a short id', block(1, { id: 'abc' })],
    ['a path as id', block(1, { id: '../../etc/passwd' })],
    ['an unknown kind', block(1, { kind: 'zip' as never })],
    ['a bidi name', block(1, { name: 'evil\u202Etxt.exe' })],
    ['a name with a path', block(1, { name: 'C:\\Users\\me\\a.txt' })],
    ['a name with a slash', block(1, { name: 'a/b.txt' })],
    ['a name with a newline', block(1, { name: 'a\nb' })],
    ['an untrimmed name', block(1, { name: ' a.txt' })],
    ['an empty name', block(1, { name: '' })],
    ['a too-long name', block(1, { name: 'x'.repeat(MAX_ATTACHMENT_NAME + 1) })],
    ['a mime with parameters', block(1, { mime: 'text/plain; charset=utf-8' })],
    ['an image that is not image/*', block(1, { kind: 'image', mime: 'text/plain' })],
    ['an image a model cannot read', block(1, { kind: 'image', mime: 'image/heic' })],
    ['a document of an unknown format', block(1, { kind: 'document', mime: 'application/zip' })],
    ['a pdf that is not application/pdf', block(1, { kind: 'pdf', mime: 'image/png' })],
    ['a negative size', block(1, { size: -1 })],
    ['a fractional size', block(1, { size: 1.5 })],
    ['a string size', block(1, { size: '1' as never })],
    ['an oversized text', block(1, { size: ATTACHMENT_LIMITS.textBytes + 1 })],
    [
      'an oversized image',
      block(1, { kind: 'image', mime: 'image/png', size: ATTACHMENT_LIMITS.imageBytes + 1 }),
    ],
    [
      'an oversized pdf',
      block(1, { kind: 'pdf', mime: 'application/pdf', size: ATTACHMENT_LIMITS.pdfBytes + 1 }),
    ],
  ])('refuses a block with %s', async (_name, forged) => {
    expect(await loads([{ role: 'user', content: [forged] }])).toBe(false)
  })

  const doc = (mime: string, extra: Partial<AttachmentBlock> = {}) =>
    block(1, { kind: 'document', mime, name: 'a.docx', ...extra })
  const derived = (source: unknown) => ({
    ...block(2, { kind: 'image', mime: 'image/png' }),
    source,
  })

  it.each([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.oasis.opendocument.text',
    'application/rtf',
    'text/rtf',
    'message/rfc822',
    'image/heic',
    'image/tiff',
  ])('accepts a document of %s', async (mime) => {
    expect(await loads([prompt('a', doc(mime))])).toBe(true)
  })

  it('limits documents and model images to their own formats and sizes', async () => {
    expect(await loads([prompt('a', doc('application/zip'))])).toBe(false)
    expect(await loads([prompt('a', doc('application/x-msdownload'))])).toBe(false)
    expect(await loads([prompt('a', doc('application/pdf', { size: 9 }))])).toBe(false)
    const big = doc('application/msword', { size: ATTACHMENT_LIMITS.documentBytes })
    expect(await loads([prompt('a', big)])).toBe(false) // over the per-message total
    expect([...attachmentIdsIn(big)]).toEqual([hex(1)])
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
      expect(await loads([prompt('a', block(1, { kind: 'image', mime }))])).toBe(true)
    for (const mime of ['image/heic', 'image/tiff', 'image/svg+xml', 'image/bmp'])
      expect(await loads([prompt('a', block(1, { kind: 'image', mime }))])).toBe(false)
  })

  it('accepts a derived attachment with a valid source', async () => {
    const full = { id: hex(1), page: 3, region: { x: 0, y: 10.5, width: 200, height: 100 } }
    expect(await loads([prompt('a', block(1), derived(full) as never)])).toBe(true)
    expect(await loads([prompt('a', derived({ id: hex(1) }) as never)])).toBe(true)
  })

  it.each<[string, unknown]>([
    ['a non-object', 'C:\\a.pdf'],
    ['a forged id', { id: '../a' }],
    ['no id', { page: 1 }],
    ['its own id', { id: hex(2) }],
    ['an extra field', { id: hex(1), path: 'C:\\a.pdf' }],
    ['page 0', { id: hex(1), page: 0 }],
    ['a fractional page', { id: hex(1), page: 1.5 }],
    ['a string page', { id: hex(1), page: '1' }],
    ['a negative region', { id: hex(1), region: { x: -1, y: 0, width: 1, height: 1 } }],
    ['an infinite region', { id: hex(1), region: { x: 0, y: 0, width: Infinity, height: 1 } }],
    ['a region missing height', { id: hex(1), region: { x: 0, y: 0, width: 1 } }],
    ['a region extra field', { id: hex(1), region: { x: 0, y: 0, width: 1, height: 1, z: 0 } }],
    ['a string region value', { id: hex(1), region: { x: '0', y: 0, width: 1, height: 1 } }],
  ])('refuses a source with %s', async (_name, source) => {
    expect(await loads([prompt('a', derived(source) as never)])).toBe(false)
  })

  it('refuses attachments outside a prompt, too many, repeated or too large in all', async () => {
    expect(await loads([prompt('a'), { role: 'assistant', content: [block()] }])).toBe(false)
    const tooMany = Array.from({ length: ATTACHMENT_LIMITS.maxPerMessage + 1 }, (_, i) =>
      block(i + 1),
    )
    expect(await loads([prompt('a', ...tooMany)])).toBe(false)
    expect(await loads([prompt('a', ...tooMany.slice(1))])).toBe(true)
    expect(await loads([prompt('a', block(1), block(1))])).toBe(false)
    const pdf = (n: number) =>
      block(n, { kind: 'pdf', mime: 'application/pdf', size: ATTACHMENT_LIMITS.pdfBytes })
    expect(await loads([prompt('a', pdf(1), pdf(2))])).toBe(true)
    expect(await loads([prompt('a', pdf(1), pdf(2), block(3, { size: 1 }))])).toBe(false)
    const call = { type: 'tool_use', id: 't1', name: 'read_file', input: {} }
    const result = { type: 'tool_result', tool_use_id: 't1', content: 'x' }
    expect(
      await loads([
        prompt('a'),
        { role: 'assistant', content: [call] },
        { role: 'user', content: [result, block()] },
      ]),
    ).toBe(false)
  })

  it('names: what a title keeps, without path separators', () => {
    expect(isAttachmentName('Report (final) — v2.pdf')).toBe(true)
    expect(isAttachmentName('a  b.txt')).toBe(false)
    expect(isAttachmentName('x'.repeat(MAX_ATTACHMENT_NAME))).toBe(true)
  })

  it('titles a chat of files only by its first attachment', () => {
    expect(titleFrom([{ role: 'user', content: [block(1)] }])).toBe('notes-1.md')
    expect(titleFrom([prompt('Summarise', block(1))])).toBe('Summarise')
  })

  it('finds ids loosely, even in chats this version cannot load', () => {
    expect([
      ...attachmentIdsIn({ messages: [prompt('a', block(1), block(2, { kind: 'zip' as never }))] }),
    ]).toEqual([hex(1), hex(2)])
    expect([...attachmentIdsIn({ type: 'attachment', id: '../x' })]).toEqual([])
  })
})

const ID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ID_B = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'
const ID_C = '2c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f'
const ID_D = '3d4e5f6a-7b8c-4d9e-8fa0-2b3c4d5e6f70'

function ids(...list: string[]) {
  const queue = [...list]
  return () => {
    const id = queue.shift()
    if (!id) throw new Error('out of ids')
    return id
  }
}

describe('forks and deletes', () => {
  /** A history under root/p with one chat of `messages`, releasing through the global scan. */
  async function setup(messages: StoredMessage[], newIds: string[] = [ID_A, ID_B, ID_C]) {
    const root = join(await tempDir(), 'history')
    const released: string[][] = []
    const release = vi.fn(async (candidates: string[]) => {
      const referenced = await referencedAttachmentIds(root)
      const free = candidates.filter((id) => !referenced.has(id))
      if (free.length > 0) released.push(free)
    })
    const history = await openHistory(join(root, 'p'), {
      newId: ids(...newIds),
      releaseAttachments: release,
    })
    await history.draft().save(messages)
    return { root, history, release, released }
  }

  it('a fork copies the attachment blocks, and keeps them while it lives', async () => {
    const messages = [prompt('one', block(1)), reply('r1'), prompt('two', block(2)), reply('r2')]
    const { history, released } = await setup(messages)
    const whole = await history.fork(ID_A, null)
    const first = await history.fork(ID_A, 1)
    expect((await history.open(whole).load()).messages).toEqual(messages)
    expect((await history.open(first).load()).messages).toEqual(messages.slice(0, 2))

    await history.remove(ID_A)
    // Both ids are still referenced by a fork.
    expect(released).toEqual([])
    await history.remove(whole)
    expect(released).toEqual([[hex(2)]])
    await history.remove(first)
    expect(released).toEqual([[hex(2)], [hex(1)]])
  })

  it('never cuts a fork between a tool call and its result', async () => {
    const call: StoredMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
    }
    const result: StoredMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }],
    }
    const { history } = await setup([
      prompt('one', block(1)),
      call,
      result,
      reply('r1'),
      prompt('two'),
    ])
    const fork = await history.fork(ID_A, 1)
    expect((await history.open(fork).load()).messages).toHaveLength(4)
  })

  it('a delete reports the ids it referenced, once the file is gone', async () => {
    const { root, history, release, released } = await setup([prompt('a', block(1), block(2))])
    // Another connection's chat still uses block 2.
    await mkdir(join(root, 'other'), { recursive: true })
    await writeFile(
      join(root, 'other', `${ID_D}.json`),
      JSON.stringify({ version: 1, messages: [prompt('b', block(2))] }),
    )
    await history.remove(ID_A)
    expect(release).toHaveBeenCalledWith([hex(1), hex(2)])
    expect(released).toEqual([[hex(1)]])
  })

  it('keeps the files of a chat it cannot load', async () => {
    const root = join(await tempDir(), 'history')
    await mkdir(join(root, 'p'), { recursive: true })
    // Written by a newer version: unknown block, but its attachment still counts.
    await writeFile(
      join(root, 'p', `${ID_D}.json`),
      JSON.stringify({
        version: 1,
        messages: [{ role: 'user', content: [{ type: 'future' }, block(5)] }],
      }),
    )
    await writeFile(join(root, 'p', 'index.json'), '{')
    expect([...(await referencedAttachmentIds(root))]).toEqual([hex(5)])
    expect(await referencedAttachmentIds(join(root, 'missing'))).toEqual(new Set())
  })

  it('a failing release never fails the delete', async () => {
    const onError = vi.fn()
    const dir = join(await tempDir(), 'p')
    const history = await openHistory(dir, {
      newId: ids(ID_A),
      onError,
      releaseAttachments: () => Promise.reject(new Error('busy')),
    })
    await history.draft().save([prompt('a', block(1))])
    await history.remove(ID_A)
    expect(history.has(ID_A)).toBe(false)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'busy' }))
    await expect(readFile(join(dir, `${ID_A}.json`))).rejects.toThrow()
  })

  it('does not report anything for a chat without attachments', async () => {
    const { history, release } = await setup([prompt('a'), reply('b')])
    await history.remove(ID_A)
    expect(release).not.toHaveBeenCalled()
  })
})
