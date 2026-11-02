import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openHistory } from '../storage/history-store'
import { createChatLibrary } from './library'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const ID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ID_B = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'
const ID_C = '2c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f'

/** A connection folder holding one chat, as any earlier build left it. */
async function folder(root: string, home: string, id: string, updatedAt: number) {
  const dir = join(root, home)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({ version: 1, messages: [{ role: 'user', content: home }] }),
  )
  await writeFile(
    join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      activeId: id,
      conversations: [{ id, title: home, createdAt: 1, updatedAt }],
    }),
  )
}

describe('chat library', () => {
  it('lists every registered connection’s chats newest first, never an unregistered folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-library-'))
    directories.push(root)
    await folder(root, 'claude-subscription', ID_A, 10)
    await folder(root, 'anthropic-api', ID_B, 30)
    await folder(root, 'future-connection', ID_C, 50)
    const open = vi.fn((home: string) => openHistory(join(root, home)))
    const library = createChatLibrary({
      connection: () => 'anthropic-api',
      registered: () => ['claude-subscription', 'codex-subscription', 'anthropic-api'],
      open,
    })
    await library.loadAll()
    expect(library.list().map((chat) => [chat.provider, chat.id, chat.title])).toEqual([
      ['anthropic-api', ID_B, 'anthropic-api'],
      ['claude-subscription', ID_A, 'claude-subscription'],
    ])
    // Only a registered id ever becomes a path.
    expect(open.mock.calls.map(([home]) => home).sort()).toEqual([
      'anthropic-api',
      'claude-subscription',
      'codex-subscription',
    ])
    await expect(library.historyFor('future-connection')).rejects.toThrow('Unknown chat.')
    expect(library.loaded('future-connection')).toBeNull()
    // One open per connection.
    await library.historyFor('anthropic-api')
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('leaves a history that fails to open unlisted, and tries again on next use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-library-'))
    directories.push(root)
    await folder(root, 'anthropic-api', ID_B, 30)
    let fail = true
    const onError = vi.fn()
    const library = createChatLibrary({
      connection: () => 'anthropic-api',
      registered: () => ['anthropic-api'],
      open: (home) => (fail ? Promise.reject(new Error('disk')) : openHistory(join(root, home))),
      onError,
    })
    await library.loadAll()
    expect(library.list()).toEqual([])
    expect(onError).toHaveBeenCalledOnce()
    fail = false
    await library.historyFor('anthropic-api')
    expect(library.list().map((chat) => chat.id)).toEqual([ID_B])
  })

  it('remembers the open chat without ever throwing', async () => {
    const onError = vi.fn()
    const library = createChatLibrary({
      connection: () => 'anthropic-api',
      registered: () => [],
      open: () => Promise.reject(new Error('unused')),
      remember: () => Promise.reject(new Error('disk full')),
      onError,
    })
    await expect(library.remember({ provider: 'anthropic-api', id: ID_A })).resolves.toBe(undefined)
    expect(onError).toHaveBeenCalledOnce()
  })
})
