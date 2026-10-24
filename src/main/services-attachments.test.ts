import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AttachmentRef } from '../shared/attachments'
import { ConnectionService } from './providers/service'
import { createAppServices } from './services'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const notes: AttachmentRef = {
  id: 'c'.repeat(64),
  name: 'notes.md',
  kind: 'text',
  mime: 'text/markdown',
  size: 4,
}

/** App services on a temp userData with a fake attachment store holding `notes`. */
async function setup() {
  const userData = await mkdtemp(join(tmpdir(), 'attach-services-'))
  dirs.push(userData)
  const provider = 'claude-subscription'
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ version: 2, provider }))
  vi.spyOn(ConnectionService.prototype, 'runner').mockImplementation(() =>
    Promise.resolve({
      run: (conversation) =>
        Promise.resolve({
          conversation: [...conversation, { role: 'assistant', content: 'reply' }],
          stopReason: 'end_turn',
        }),
    }),
  )
  const attachments = {
    has: vi.fn((id: string) => Promise.resolve(id === notes.id)),
    describe: vi.fn((id: string) => Promise.resolve(id === notes.id ? notes : null)),
    isIssued: (id: string) => id === notes.id,
    release: vi.fn(() => Promise.resolve()),
  }
  const { chat, projects } = await createAppServices({
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
    attachments,
  })
  // A chat that attaches `notes`, and a fork of it.
  expect(await chat.send('Read this', [notes.id])).toEqual({ ok: true })
  await chat.idle()
  const source = chat.historyState().activeId ?? ''
  const { chat: fork } = await projects.fork({ provider, id: source }, null)
  return { userData, provider, attachments, chat, projects, source, fork }
}

it('releases a file only when the last chat that references it is deleted', async () => {
  const { attachments, chat, projects, source, fork } = await setup()
  await chat.remove(source)
  expect(attachments.release).not.toHaveBeenCalled()
  // Opened, the fork shows the file; deleting it frees the file.
  await chat.open(fork.id)
  expect(chat.state().items[0]).toMatchObject({ attachments: [{ id: notes.id, available: true }] })
  await projects.removeChat(fork)
  expect(attachments.release).toHaveBeenCalledExactlyOnceWith([notes.id])
})

it('releases nothing while any chat file cannot be read, and says so', async () => {
  const { userData, provider, attachments, chat, projects, source, fork } = await setup()
  await writeFile(
    join(userData, 'history', provider, '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f.json'),
    '{',
  )
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await chat.remove(source)
  await projects.removeChat(fork)
  expect(attachments.release).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 chat file(s) could not be read'))
})

it('refuses an attachment the real store never issued', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'attach-none-'))
  dirs.push(userData)
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ version: 2, provider: 'claude-subscription' }),
  )
  const runner = vi.spyOn(ConnectionService.prototype, 'runner')
  const { chat } = await createAppServices({
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
  expect(await chat.send('Read this', [notes.id])).toMatchObject({
    ok: false,
    message: expect.stringContaining('ttach') as string,
  })
  expect(runner).not.toHaveBeenCalled()
  expect(chat.historyState().conversations).toEqual([])
})
