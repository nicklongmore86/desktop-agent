/**
 * What dropping a dragged chat on a part of the chat list does. Pure, so the
 * rules are tested on their own; the sidebar applies the result. Every drop has
 * a menu equivalent (Pin, Move to project, Remove from project).
 */
export interface DragSource {
  pinned: boolean
  projectId: string | null
  archived: boolean
}

export type DropTarget =
  | { kind: 'pin' }
  | { kind: 'project'; projectId: string }
  /** The Chats section: out of its project (and unpinned). */
  | { kind: 'ungroup' }

export type DropAction =
  | { kind: 'none' }
  | { kind: 'pin' }
  /** A pinned chat is unpinned too, so it visibly lands in the project. */
  | { kind: 'move'; projectId: string; unpin: boolean }
  | { kind: 'ungroup'; unfile: boolean; unpin: boolean }

const NONE: DropAction = { kind: 'none' }

export function resolveDrop(source: DragSource, target: DropTarget): DropAction {
  // Archived chats are only listed in the Archived view, which has no drop targets.
  if (source.archived) return NONE
  switch (target.kind) {
    case 'pin':
      return source.pinned ? NONE : { kind: 'pin' }
    case 'project':
      if (source.projectId === target.projectId && !source.pinned) return NONE
      return { kind: 'move', projectId: target.projectId, unpin: source.pinned }
    case 'ungroup':
      if (source.projectId === null && !source.pinned) return NONE
      return { kind: 'ungroup', unfile: source.projectId !== null, unpin: source.pinned }
  }
}
