import { describe, expect, it } from 'vitest'
import type { HistoryState } from '../../../../shared/ipc'
import type { ProjectsState } from '../../../../shared/ipc-projects'
import { arrangeChats } from './arrange'
import { resolveDrop, type DragSource } from './drop'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

describe('resolveDrop', () => {
  const loose: DragSource = { pinned: false, projectId: null, archived: false }
  const filed: DragSource = { pinned: false, projectId: P1, archived: false }
  const pinned: DragSource = { pinned: true, projectId: null, archived: false }
  const pinnedFiled: DragSource = { pinned: true, projectId: P1, archived: false }

  it.each([
    ['a loose chat onto Pinned', loose, { kind: 'pin' }, { kind: 'pin' }],
    ['a pinned chat onto Pinned', pinned, { kind: 'pin' }, { kind: 'none' }],
    [
      'a loose chat onto a project',
      loose,
      { kind: 'project', projectId: P1 },
      { kind: 'move', projectId: P1, unpin: false },
    ],
    ['a chat onto its own project', filed, { kind: 'project', projectId: P1 }, { kind: 'none' }],
    [
      'a chat onto another project',
      filed,
      { kind: 'project', projectId: P2 },
      { kind: 'move', projectId: P2, unpin: false },
    ],
    [
      'a pinned chat onto its own project (it lands there, unpinned)',
      pinnedFiled,
      { kind: 'project', projectId: P1 },
      { kind: 'move', projectId: P1, unpin: true },
    ],
    [
      'a filed chat onto Chats',
      filed,
      { kind: 'ungroup' },
      { kind: 'ungroup', unfile: true, unpin: false },
    ],
    [
      'a pinned chat onto Chats',
      pinned,
      { kind: 'ungroup' },
      { kind: 'ungroup', unfile: false, unpin: true },
    ],
    ['a loose chat onto Chats', loose, { kind: 'ungroup' }, { kind: 'none' }],
    [
      'an archived chat anywhere',
      { ...filed, archived: true },
      { kind: 'project', projectId: P2 },
      { kind: 'none' },
    ],
  ] as const)('%s', (_name, source, target, expected) => {
    expect(resolveDrop(source, target)).toEqual(expected)
  })
})

describe('arrangeChats', () => {
  const chat = (id: string, updatedAt: number, extra: object = {}) => ({
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  })
  const history: HistoryState = {
    activeId: null,
    conversations: [
      chat('a', 50),
      chat('b', 40, { pinnedAt: 9 }),
      chat('c', 30, { pinnedAt: 3, projectId: P1 }),
      chat('d', 20, { projectId: P1 }),
      chat('e', 10, { projectId: 'gone-project' }),
      chat('f', 60, { archivedAt: 1, projectId: P1 }),
    ],
  }
  const projects: ProjectsState = {
    provider: 'anthropic-api',
    projects: [
      { id: P1, name: 'One', icon: null },
      { id: P2, name: 'Two', icon: null },
    ],
    others: [
      { ...chat('x', 70, { projectId: P1 }), provider: 'codex-subscription' },
      { ...chat('y', 5, { pinnedAt: 1 }), provider: 'claude-subscription' },
      // The open provider's chats come from the history, never from `others`.
      { ...chat('z', 99), provider: 'anthropic-api' },
    ],
  }

  it('puts each chat in one section: pins first, then projects, then the rest', () => {
    const arranged = arrangeChats(history, projects, 'anthropic-api')
    expect(arranged.pinned.map((c) => c.id)).toEqual(['y', 'c', 'b'])
    expect(arranged.projects.map((g) => [g.project.id, g.chats.map((c) => c.id)])).toEqual([
      [P1, ['x', 'd']],
      [P2, []],
    ])
    // A chat naming a deleted project lists as unfiled.
    expect(arranged.loose.map((c) => c.id)).toEqual(['a', 'e'])
    expect(arranged.archived.map((c) => c.id)).toEqual(['f'])
    expect(arranged.count).toBe(7)
    expect(arranged.projects[0]?.chats[0]?.provider).toBe('codex-subscription')
  })

  it('lists only the history before the projects have loaded', () => {
    const arranged = arrangeChats(history, null, null)
    expect(arranged.projects).toEqual([])
    expect(arranged.loose.map((c) => c.id)).toEqual(['a', 'd', 'e'])
  })
})
