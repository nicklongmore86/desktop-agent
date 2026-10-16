import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, FileLocation } from '../../../../shared/ipc-files'
import { useApi } from '../../api'
import { useToast } from '../Toast'
import { endFileDrag, startFileDrag } from './drag'
import { FILE_KIND_LABELS, fileKind } from './file-kind'
import { useInsertFileReference } from './file-references'
import { FileIcon } from './FileIcon'
import { FileMenu, type FileMenuItem } from './FileMenu'
import { isExpandable, type TreeRow } from './use-file-tree'

/** Row height in px (matches .tree-row in files.css). */
export const ROW_HEIGHT = 28
/** Rows drawn above and below the visible ones. */
const OVERSCAN = 10
/** Trees with more rows than this draw only the visible ones. */
export const WINDOW_THRESHOLD = 150
/** Indent per level, px. */
const INDENT = 16

type ItemRow = Exclude<TreeRow, { type: 'status' }>

/** Why an entry cannot be referenced, revealed or copied; null when it can. */
function lockReason(entry: FileEntry): string | null {
  if (entry.denied) return entry.denied
  if (entry.kind === 'link')
    return entry.linkOutside
      ? 'A link to a place outside your granted folders. It is not followed.'
      : 'A link. Links are not followed.'
  if (entry.secret) return 'A secrets file: its contents stay hidden here.'
  return null
}

function referenceBlock(row: ItemRow): string | null {
  if (row.type === 'root') return null
  const { entry } = row
  const lock = lockReason(entry)
  if (lock) return lock
  if (entry.kind === 'other') return 'Only files and folders can be referenced.'
  if (entry.hardLink) return 'This file has other hard links, so the agent cannot open it.'
  return null
}

function describe(row: ItemRow): string {
  if (row.type === 'root') return 'Granted folder'
  const { entry } = row
  if (entry.denied) return `Blocked: ${entry.denied}`
  if (entry.kind === 'link')
    return entry.linkOutside ? 'Link outside granted folders, not followed' : 'Link, not followed'
  if (entry.kind === 'dir') return 'Folder'
  if (entry.secret) return 'Secret file, contents hidden'
  const label = FILE_KIND_LABELS[fileKind(entry.name)]
  return entry.hardLink ? `${label}, has other hard links` : label
}

const locationOf = (row: ItemRow): FileLocation =>
  row.type === 'root'
    ? { rootId: row.root.id, rel: '' }
    : { rootId: row.rootId, rel: row.entry.rel }

const isOpenable = (row: TreeRow): boolean =>
  row.type === 'root' || (row.type === 'entry' && isExpandable(row.entry))

/**
 * The Files tree: a WAI-ARIA tree of the granted folders. Focus stays on the tree
 * and `aria-activedescendant` names the active row, so rows can be windowed (only
 * the visible ones drawn) without losing the keyboard position.
 *
 * Keys: Up/Down, Home/End, Right (expand, then first child), Left (collapse, then
 * parent), Enter (expand/collapse a folder, or insert a file's reference into the
 * chat), Shift+F10 or the Menu key (actions). Entries drag into the message box
 * as a reference only; nothing is dropped onto the tree, so the tree never moves files.
 */
export function FileTree({
  rows,
  setOpen,
  refresh,
  unwatched,
  onRemoveRoot,
}: {
  rows: TreeRow[]
  setOpen: (key: string, open: boolean) => void
  refresh: (key: string) => void
  unwatched: ReadonlySet<string>
  onRemoveRoot: (path: string) => void
}): React.JSX.Element {
  const api = useApi()
  const notify = useToast()
  const insertReference = useInsertFileReference()
  const treeId = useId()
  const tree = useRef<HTMLDivElement>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)

  // Position in set for each row among its siblings (status lines are not counted).
  const positions = useMemo(() => {
    const groups = new Map<string, string[]>()
    for (const row of rows) {
      if (row.type === 'status') continue
      const parent = row.type === 'root' ? '' : row.parentKey
      groups.set(parent, [...(groups.get(parent) ?? []), row.key])
    }
    const out = new Map<string, { pos: number; size: number }>()
    for (const keys of groups.values())
      keys.forEach((key, index) => out.set(key, { pos: index + 1, size: keys.length }))
    return out
  }, [rows])

  const found = rows.findIndex((row) => row.key === activeKey && row.type !== 'status')
  const activeIndex = found >= 0 ? found : rows.findIndex((row) => row.type !== 'status')
  const active = rows[activeIndex] as ItemRow | undefined

  useEffect(() => {
    const element = tree.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setViewport(element.clientHeight || 600)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  // Keep the active row in view when the keyboard moves it.
  const followActive = useRef(false)
  useLayoutEffect(() => {
    const element = tree.current
    if (!followActive.current || !element || activeIndex < 0) return
    followActive.current = false
    const top = activeIndex * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight
    setScrollTop(element.scrollTop)
  }, [activeIndex])

  const windowed = rows.length > WINDOW_THRESHOLD
  const start = windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0
  const end = windowed
    ? Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
    : rows.length

  const rowId = (index: number) => `${treeId}-row-${String(index)}`

  const moveTo = (index: number): void => {
    const row = rows[index]
    if (!row || row.type === 'status') return
    followActive.current = true
    setActiveKey(row.key)
  }
  const step = (from: number, delta: 1 | -1): void => {
    for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
      if (rows[i]?.type !== 'status') {
        moveTo(i)
        return
      }
    }
  }

  const run = async (action: () => Promise<{ ok: boolean; reason?: string }>, done?: string) => {
    try {
      const result = await action()
      if (!result.ok) notify(result.reason ?? 'That did not work.')
      else if (done) notify(done)
    } catch {
      notify('That did not work.')
    }
  }

  const menuItems = (row: ItemRow): FileMenuItem[] => {
    const location = locationOf(row)
    const blockedRef = referenceBlock(row)
    const blockedPath = row.type === 'entry' ? lockReason(row.entry) : null
    const pathBlock =
      row.type === 'entry' && row.entry.secret && !row.entry.denied ? null : blockedPath
    const items: FileMenuItem[] = [
      {
        label: 'Insert reference into chat',
        disabled: blockedRef,
        onSelect: () => {
          void insertReference(location)
        },
      },
      {
        label: 'Copy path',
        disabled: pathBlock,
        onSelect: () => {
          void run(() => api.files.copyPath(location), 'Path copied')
        },
      },
      {
        label: 'Reveal in Explorer',
        disabled: pathBlock,
        onSelect: () => {
          void run(() => api.files.reveal(location))
        },
      },
    ]
    if (isOpenable(row) && row.expanded)
      items.push({
        label: 'Refresh',
        disabled: null,
        onSelect: () => {
          refresh(row.key)
        },
      })
    if (row.type === 'root')
      items.push({
        label: 'Remove folder access',
        disabled: null,
        onSelect: () => {
          onRemoveRoot(row.root.path)
        },
      })
    return items
  }

  const openMenu = (row: ItemRow, x: number, y: number): void => {
    setActiveKey(row.key)
    setMenu({ key: row.key, x, y })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
      return
    if (!active) return
    const open = isOpenable(active)
    let handled = true
    switch (event.key) {
      case 'ArrowDown':
        step(activeIndex, 1)
        break
      case 'ArrowUp':
        step(activeIndex, -1)
        break
      case 'Home':
        step(-1, 1)
        break
      case 'End':
        step(rows.length, -1)
        break
      case 'ArrowRight':
        if (open && !active.expanded) setOpen(active.key, true)
        else if (open) step(activeIndex, 1)
        break
      case 'ArrowLeft':
        if (open && active.expanded) setOpen(active.key, false)
        else if (active.type === 'entry') moveTo(rows.findIndex((r) => r.key === active.parentKey))
        break
      case 'Enter':
        if (open) setOpen(active.key, !active.expanded)
        else if (!referenceBlock(active)) void insertReference(locationOf(active))
        else notify(referenceBlock(active) ?? '')
        break
      case 'ContextMenu':
        openRowMenu()
        break
      case 'F10':
        if (event.shiftKey) openRowMenu()
        else handled = false
        break
      default:
        handled = false
    }
    if (handled) event.preventDefault()

    function openRowMenu(): void {
      if (!active) return
      const element = document.getElementById(rowId(activeIndex))
      const box = element?.getBoundingClientRect()
      openMenu(active, box ? box.left + 24 : 0, box ? box.bottom : 0)
    }
  }

  const menuRow = menu ? (rows.find((row) => row.key === menu.key) as ItemRow | undefined) : null

  return (
    <>
      <div
        ref={tree}
        className="file-tree"
        role="tree"
        aria-label="Files in granted folders"
        aria-activedescendant={active ? rowId(activeIndex) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop)
        }}
      >
        {start > 0 && <div role="none" style={{ height: start * ROW_HEIGHT }} />}
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset
          const indent = { paddingInlineStart: (row.level - 1) * INDENT + 4 }
          if (row.type === 'status')
            return (
              <div
                key={row.key}
                id={rowId(index)}
                role="treeitem"
                aria-level={row.level}
                aria-disabled="true"
                aria-selected="false"
                className={`tree-row tree-status tree-status-${row.tone}`}
                style={indent}
              >
                {row.text}
              </div>
            )
          const position = positions.get(row.key)
          const open = isOpenable(row)
          const entry = row.type === 'entry' ? row.entry : null
          const locked = entry ? lockReason(entry) : null
          const draggable = row.type === 'entry' && referenceBlock(row) === null
          const name = row.type === 'root' ? row.root.name : row.entry.name
          return (
            <div
              key={row.key}
              id={rowId(index)}
              role="treeitem"
              aria-level={row.level}
              aria-setsize={position?.size}
              aria-posinset={position?.pos}
              aria-expanded={open ? row.expanded : undefined}
              aria-selected={index === activeIndex}
              className={[
                'tree-row',
                row.type === 'root' ? 'tree-root' : '',
                index === activeIndex ? 'tree-row-active' : '',
                locked ? 'tree-row-locked' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={indent}
              title={locked ?? (row.type === 'root' ? row.root.path : undefined)}
              draggable={draggable}
              onDragStart={(event) => {
                if (!draggable) {
                  event.preventDefault()
                  return
                }
                startFileDrag(event.dataTransfer, locationOf(row))
              }}
              onDragEnd={endFileDrag}
              onClick={() => {
                setActiveKey(row.key)
                tree.current?.focus()
                if (open) setOpen(row.key, !row.expanded)
              }}
              onDoubleClick={() => {
                if (!open && referenceBlock(row) === null) void insertReference(locationOf(row))
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                tree.current?.focus()
                openMenu(row, event.clientX, event.clientY)
              }}
            >
              <span className="tree-twisty" aria-hidden="true">
                {open ? (row.expanded ? '▾' : '▸') : ''}
              </span>
              <FileIcon
                name={name}
                kind={entry?.kind ?? 'dir'}
                open={row.expanded}
                locked={Boolean(entry?.denied || entry?.secret)}
              />
              <span className="tree-name">{name}</span>
              {row.type === 'root' && <span className="tree-root-path">{row.root.path}</span>}
              {entry?.kind === 'link' && (
                <span className="tree-badge">{entry.linkOutside ? 'link · outside' : 'link'}</span>
              )}
              {entry?.secret && !entry.denied && <span className="tree-badge">hidden</span>}
              {entry?.hardLink && <span className="tree-badge">hard link</span>}
              <span className="visually-hidden">, {describe(row)}</span>
              {unwatched.has(row.key) && row.expanded && (
                <button
                  type="button"
                  className="tree-action"
                  tabIndex={-1}
                  aria-label={`Refresh ${name}`}
                  title="Not watching for changes. Refresh"
                  onClick={(event) => {
                    event.stopPropagation()
                    refresh(row.key)
                  }}
                >
                  ↻
                </button>
              )}
              {row.type === 'root' && (
                <button
                  type="button"
                  className="tree-action tree-remove"
                  tabIndex={-1}
                  aria-label={`Remove ${row.root.path}`}
                  title="Remove folder access"
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemoveRoot(row.root.path)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
        {end < rows.length && (
          <div role="none" style={{ height: (rows.length - end) * ROW_HEIGHT }} />
        )}
      </div>
      {menu && menuRow && (
        <FileMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menuRow.type === 'root' ? menuRow.root.name : menuRow.entry.name}`}
          note={menuRow.type === 'entry' ? lockReason(menuRow.entry) : null}
          items={menuItems(menuRow)}
          onClose={() => {
            setMenu(null)
            tree.current?.focus()
          }}
        />
      )}
    </>
  )
}
