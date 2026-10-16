import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId, ProviderStatus } from '../../shared/ipc'
import { openHistory, type ConversationHistory } from '../storage/history-store'
import { openProjectsStore } from '../storage/projects-store'
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
  const ids = new Map<ProviderId, string[]>([
    ['anthropic-api', [API_CHAT]],
    ['codex-subscription', [CODEX_CHAT, CODEX_LOOSE, FORK]],
    ['claude-subscription', []],
  ])
  const histories = new Map<ProviderId, ConversationHistory>()
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
  let provider: ProviderId = 'anthropic-api'
  const status = (): ProviderStatus => ({ provider, state: 'ready', message: 'ok' })
  const chat = {
    rename: vi.fn(() => Promise.resolve({ conversations: [], activeId: null })),
    remove: vi.fn(() => Promise.resolve({ conversations: [], activeId: null })),
    open: vi.fn(() => Promise.resolve()),
    historyChanged: vi.fn(),
  }
  const switchProvider = vi.fn((next: ProviderId) => {
    provider = next
    return Promise.resolve(status())
  })
  const organizer = createOrganizer({
    projects,
    historyFor: (p) => {
      const history = histories.get(p)
      return history ? Promise.resolve(history) : Promise.reject(new Error('no history'))
    },
    provider: () => provider,
    chat,
    switchProvider,
    status: () => Promise.resolve(status()),
  })
  const codex = histories.get('codex-subscription') as ConversationHistory
  return { organizer, chat, switchProvider, codex, projects }
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

  it("tells the session only about the open provider's list", async () => {
    const { organizer, chat } = await setup()
    await organizer.archive({ provider: 'codex-subscription', id: CODEX_CHAT }, true)
    expect(chat.historyChanged).not.toHaveBeenCalled()
    await organizer.archive({ provider: 'anthropic-api', id: API_CHAT }, true)
    expect(chat.historyChanged).toHaveBeenCalledOnce()
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

  it('forks into the same provider and routes the open provider through the session', async () => {
    const { organizer, chat, codex } = await setup()
    const forked = await organizer.fork({ provider: 'codex-subscription', id: CODEX_CHAT }, null)
    expect(forked.chat).toEqual({ provider: 'codex-subscription', id: FORK })
    expect(codex.has(FORK)).toBe(true)
    await organizer.renameChat({ provider: 'anthropic-api', id: API_CHAT }, 'New name')
    expect(chat.rename).toHaveBeenCalledWith(API_CHAT, 'New name')
    await organizer.renameChat({ provider: 'codex-subscription', id: CODEX_CHAT }, 'Codex name')
    expect(codex.state().conversations.find((c) => c.id === CODEX_CHAT)?.title).toBe('Codex name')
    await organizer.removeChat({ provider: 'codex-subscription', id: FORK })
    expect(codex.has(FORK)).toBe(false)
    await organizer.removeChat({ provider: 'anthropic-api', id: API_CHAT })
    expect(chat.remove).toHaveBeenCalledWith(API_CHAT)
  })

  it("opens another provider's chat through the provider switch, with that chat", async () => {
    const { organizer, chat, switchProvider } = await setup()
    const status = await organizer.open({ provider: 'codex-subscription', id: CODEX_CHAT })
    expect(switchProvider).toHaveBeenCalledWith('codex-subscription', CODEX_CHAT)
    expect(status.provider).toBe('codex-subscription')
    await organizer.open({ provider: 'codex-subscription', id: CODEX_LOOSE })
    expect(chat.open).toHaveBeenCalledWith(CODEX_LOOSE)
    expect(switchProvider).toHaveBeenCalledOnce()
    await expect(organizer.open({ provider: 'anthropic-api', id: FORK })).rejects.toThrow(
      'That chat no longer exists.',
    )
  })
})
