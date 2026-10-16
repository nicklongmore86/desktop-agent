import type { FileLocation } from '../../../../shared/ipc-files'

/**
 * Dragging an entry from the Files tree to the composer. The drag carries only a
 * random token under a private type; the location stays in this module. A drop
 * is accepted only when its token is the one this window issued, so a drag from
 * another app (or a crafted one) can never name a file. The drag sets no text,
 * URL or file data, so dropping it outside the app carries nothing.
 */
export const FILE_DRAG_TYPE = 'application/x-desktop-agent-file'

let current: { token: string; location: FileLocation } | null = null

export function startFileDrag(data: DataTransfer, location: FileLocation): void {
  const token = crypto.randomUUID()
  current = { token, location: { ...location } }
  data.clearData()
  data.setData(FILE_DRAG_TYPE, token)
  // A reference is inserted, the file is never moved or copied.
  data.effectAllowed = 'link'
}

export function endFileDrag(): void {
  current = null
}

/** True while the drag over an element is one of ours (data is not readable until drop). */
export function isFileDrag(data: DataTransfer | null): boolean {
  return current !== null && data !== null && Array.from(data.types).includes(FILE_DRAG_TYPE)
}

/** The dragged location, once, when the drop carries this window's token; otherwise null. */
export function takeFileDrop(data: DataTransfer | null): FileLocation | null {
  const token = data?.getData(FILE_DRAG_TYPE)
  if (!current || !token || token !== current.token) return null
  const { location } = current
  current = null
  return location
}
