import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatRef, ProviderStatus } from '../../shared/ipc'
import type { ConnectionId } from '../../shared/ipc-connections'
import { openHistory, type ConversationHistory } from '../storage/history-store'
import { openProjectsStore } from '../storage/projects-store'
import { createChatLibrary } from './library'
import { createOrganizer } from './organizer'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const API_CHAT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CODEX_CHAT = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'
const CODEX_LOOSE = '2c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f'
const FORK = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a'
const PROJECT = '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agent-organizer-'))
  directories.push(root)
  // Real stores in a temp folder, one history per provider.
  const ids = new Map<ConnectionId, string[]>([
    ['anthropic-api', [API_CHAT]],
    ['codex-subscription', [CODEX_CHAT, CODEX_LOOSE, FORK]],
    ['claude-subscription', []],
  ])
  const histories = new Map<ConnectionId, ConversationHistory>()
  for (const [provider, list] of ids) {
    const queue = [...list]
    const history = await openHistory(join(root, 'history', provider), {
      newId: () => queue.shift() ?? 'out-of-ids',
    })
    histories.set(provider, history)
  }
  await histories
    .get('anthropic-api')
    ?.draft()
    .save([{ role: 'user', content: 'api chat' }])
  await histories
    .get('codex-subscription')
    ?.draft()
    .save([{ role: 'user', content: 'codex chat' }])
  await histories
    .get('codex-subscription')
    ?.draft()
    .save([{ role: 'user', content: 'loose' }])
  const projects = await openProjectsStore(join(root, 'projects.json'), { newId: () => PROJECT })
  let provider: ConnectionId = 'anthropic-api'
  const status = (): ProviderStatus => ({ provider, state: 'ready', message: 'ok' })
  const library = createChatLibrary({
    connection: () => provider,
    registered: () => [...ids.keys()],
    open: (home) => {
      const history = histories.get(home)
      return history ? Promise.resolve(history) : Promise.reject(new Error('no history'))
    },
  })
  await library.loadAll()
  const empty = { conversations: [], activeId: null }
  const chat = {
    renameChat: vi.fn(async (ref: ChatRef, title: string) => {
      await histories.get(ref.provider)?.rename(ref.id, title)
      return empty
    }),
    removeChat: vi.fn(async (ref: ChatRef) => {
      await histories.get(ref.provider)?.remove(ref.id)
      return empty
    }),
    openChat: vi.fn(() => Promise.resolve()),
    historyChanged: vi.fn(),
  }
  const organizer = createOrganizer({
    projects,
    library,
    chat,
    status: () => Promise.resolve(status()),
  })
  const codex = histories.get('codex-subscription') as ConversationHistory
  const switchTo = (next: ConnectionId): void => {
    provider = next
  }
  return { organizer, chat, codex, projects, switchTo }
}

describe('organizer', () => {
  it("lists other providers' chats only when they are pinned or in a project", async () => {
    const { organizer } = await setup()
    const { project } = await organizer.create('Taxes', '📊')
    expect((await organizer.state()).others).toEqual([])
    await organizer.moveChat({ provider: 'codex-subscription', id: CODEX_CHAT }, project.id)
    const state = await organizer.pin({ provider: 'codex-subscription', id: CODEX_LOOSE }, true)
    expect(state.provider).toBe('anthropic-api')
    expect(state.projects).toEqual([{ id: PROJECT, name: 'Taxes', icon: '📊' }])
    expect(state.others.map((c) => [c.provider, c.id, c.projectId ?? null]).sort()).toEqual(
      [
        ['codex-subscription', CODEX_CHAT, PROJECT],
        ['codex-subscription', CODEX_LOOSE, null],
      ].sort(),
    )
  })

  it('tells the session about every change, whatever the home (the list is shared)', async () => {
    const { organizer, chat } = await setup()
    await organizer.archive({ provider: 'codex-subscription', id: CODEX_CHAT }, true)
    await organizer.archive({ provider: 'anthropic-api', id: API_CHAT }, true)
    expect(chat.historyChanged).toHaveBeenCalledTimes(2)
  })

  it('refuses a project that does not exist and a chat that does not', async () => {
    const { organizer } = await setup()
    await expect(
      organizer.moveChat({ provider: 'anthropic-api', id: API_CHAT }, PROJECT),
    ).rejects.toThrow('That project no longer exists.')
    await expect(
      organizer.pin({ provider: 'claude-subscription', id: API_CHAT }, true),
    ).rejects.toThrow('That chat no longer exists.')
  })

  it("deleting a project unfiles its chats in every provider's history", async () => {
    const { organizer, codex } = await setup()
    const { project } = await organizer.create('Trip', null)
    await organizer.moveChat({ provider: 'anthropic-api', id: API_CHAT }, project.id)
    await organizer.moveChat({ provider: 'codex-subscription', id: CODEX_CHAT }, project.id)
    const state = await organizer.remove(project.id)
    expect(state.projects).toEqual([])
    expect(codex.state().conversations.every((c) => c.projectId === undefined)).toBe(true)
  })

  it('forks into the same home and routes renames and deletes through the session', async () => {
    const { organizer, chat, codex } = await setup()
    const forked = await organizer.fork({ provider: 'codex-subscription', id: CODEX_CHAT }, null)
    expect(forked.chat).toEqual({ provider: 'codex-subscription', id: FORK })
    expect(codex.has(FORK)).toBe(true)
    await organizer.renameChat({ provider: 'codex-subscription', id: CODEX_CHAT }, 'Codex name')
    expect(chat.renameChat).toHaveBeenCalledWith(
      { provider: 'codex-subscription', id: CODEX_CHAT },
      'Codex name',
    )
    expect(codex.state().conversations.find((c) => c.id === CODEX_CHAT)?.title).toBe('Codex name')
    await organizer.removeChat({ provider: 'codex-subscription', id: FORK })
    expect(chat.removeChat).toHaveBeenCalledWith({ provider: 'codex-subscription', id: FORK })
    expect(codex.has(FORK)).toBe(false)
    await expect(
      organizer.renameChat({ provider: 'anthropic-api', id: FORK }, 'x'),
    ).rejects.toThrow('That chat no longer exists.')
  })

  it("opens any home's chat on the current connection, never switching connection", async () => {
    const { organizer, chat } = await setup()
    const status = await organizer.open({ provider: 'codex-subscription', id: CODEX_CHAT })
    expect(chat.openChat).toHaveBeenCalledWith({ provider: 'codex-subscription', id: CODEX_CHAT })
    expect(status.provider).toBe('anthropic-api')
    await expect(organizer.open({ provider: 'anthropic-api', id: FORK })).rejects.toThrow(
      'That chat no longer exists.',
    )
    expect(chat.openChat).toHaveBeenCalledOnce()
  })

  it("lists the current connection's pinned chats of other homes after a switch", async () => {
    const { organizer, switchTo } = await setup()
    await organizer.pin({ provider: 'anthropic-api', id: API_CHAT }, true)
    expect((await organizer.state()).others).toEqual([])
    switchTo('codex-subscription')
    const state = await organizer.state()
    expect(state.provider).toBe('codex-subscription')
    expect(state.others.map((c) => [c.provider, c.id])).toEqual([['anthropic-api', API_CHAT]])
  })
})
