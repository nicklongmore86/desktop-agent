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

it('releases a file only when the last chat that references it is deleted', async () => {
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
  expect(await chat.send('Read this', [notes])).toEqual({ ok: true })
  await chat.idle()
  const source = chat.historyState().activeId ?? ''
  const { chat: fork } = await projects.fork({ provider, id: source }, null)

  await chat.remove(source)
  expect(attachments.release).not.toHaveBeenCalled()
  // Opened, the fork shows the file; deleting it frees the file.
  await chat.open(fork.id)
  expect(chat.state().items[0]).toMatchObject({ attachments: [{ id: notes.id, available: true }] })
  await projects.removeChat(fork)
  expect(attachments.release).toHaveBeenCalledExactlyOnceWith([notes.id])
})
