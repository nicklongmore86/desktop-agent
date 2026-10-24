import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { ConnectionService } from './providers/service'
import { createAppServices } from './services'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const provider = 'claude-subscription'

async function start(userData: string, sent: MessageParam[][] = []) {
  vi.spyOn(ConnectionService.prototype, 'runner').mockImplementation(() =>
    Promise.resolve({
      run: (conversation) => {
        sent.push(conversation)
        return Promise.resolve({
          conversation: [...conversation, { role: 'assistant', content: 'reply' }],
          stopReason: 'end_turn',
        })
      },
    }),
  )
  return createAppServices({
    userData,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (value) => value.toString(),
    },
    trash: () => Promise.resolve(),
    emit: vi.fn(),
    promptApproval: vi.fn(),
    onAuditStatus: vi.fn(),
  })
}

async function newUserData() {
  const userData = await mkdtemp(join(tmpdir(), 'attach-store-'))
  dirs.push(userData)
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ version: 2, provider }))
  return userData
}

const meta = { name: 'notes.md', kind: 'text', mime: 'text/markdown' } as const

it('keeps an attachment usable across a restart: issue, send, save, reopen, send again', async () => {
  const userData = await newUserData()
  const first = await start(userData)
  const ref = await first.attachmentStore.issue(Buffer.from('secret-free notes'), meta)
  expect(await first.chat.send('Read this', [ref.id])).toEqual({ ok: true })
  await first.chat.idle()
  const chatId = first.chat.historyState().activeId ?? ''

  // A new app session: nothing is issued yet, but the saved chat registers its files.
  const sent: MessageParam[][] = []
  const second = await start(userData, sent)
  expect(second.chat.state().items[0]).toMatchObject({
    attachments: [{ id: ref.id, available: true }],
  })
  expect(second.attachmentStore.isIssued(ref.id)).toBe(true)
  expect(await second.chat.send('And again', [])).toEqual({ ok: true })
  await second.chat.idle()
  expect(JSON.stringify(sent[0])).toContain('secret-free notes')

  // Another session opening a different chat first does the same when it opens this one.
  await second.chat.newChat()
  await second.chat.open(chatId)
  expect(second.attachmentStore.isIssued(ref.id)).toBe(true)
})

it('does not accept an id that was never issued or registered', async () => {
  const userData = await newUserData()
  const { chat } = await start(userData)
  expect(await chat.send('Read this', ['d'.repeat(64)])).toMatchObject({ ok: false })
})

it('startup cleanup removes only unreferenced files older than a day', async () => {
  const userData = await newUserData()
  const first = await start(userData)
  const kept = await first.attachmentStore.issue(Buffer.from('kept'), meta)
  const unused = await first.attachmentStore.issue(Buffer.from('unused'), { ...meta, name: 'u.md' })
  const fresh = await first.attachmentStore.issue(Buffer.from('fresh'), { ...meta, name: 'f.md' })
  await first.chat.send('hi', [kept.id])
  await first.chat.idle()
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  const { utimes } = await import('node:fs/promises')
  for (const id of [kept.id, unused.id]) await utimes(join(userData, 'attachments', id), old, old)

  await start(userData)
  const names = await readdir(join(userData, 'attachments'))
  expect(names).toContain(kept.id)
  expect(names).toContain(fresh.id)
  expect(names).not.toContain(unused.id)
})

it('startup cleanup removes nothing while a chat file cannot be read', async () => {
  const userData = await newUserData()
  const first = await start(userData)
  const unused = await first.attachmentStore.issue(Buffer.from('unused'), meta)
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  const { utimes } = await import('node:fs/promises')
  await utimes(join(userData, 'attachments', unused.id), old, old)
  await mkdir(join(userData, 'history', provider), { recursive: true })
  await writeFile(
    join(userData, 'history', provider, '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f.json'),
    '{',
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await start(userData)
  expect(await readdir(join(userData, 'attachments'))).toContain(unused.id)
})
