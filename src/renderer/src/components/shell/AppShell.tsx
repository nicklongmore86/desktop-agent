import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
} from 'react'
import { LEFT_DEFAULT, RIGHT_DEFAULT } from '../../../../shared/ipc-layout'
import { computeGeometry } from '../../layout'
import { useLayoutHotkeys } from '../../use-shortcuts'
import { useLayoutPrefs } from '../../use-layout-prefs'
import { useResizablePane } from '../../use-resizable-pane'
import { Drawer } from './Drawer'
import {
  ShellContext,
  type PaneControl,
  type PaneVariant,
  type ShellContextValue,
} from './shell-context'

export interface ShellHandle {
  closeDrawer: () => void
}

export interface AppShellProps {
  /** The chats sidebar. Rendered once: docked beside the chat, or inside the left drawer. */
  left: (variant: PaneVariant) => React.ReactNode
  /** The Workspace panel, likewise. */
  right: (variant: PaneVariant) => React.ReactNode
  /** Settings is open: the panes, drawers and chat behind it are inert. */
  inert: boolean
  /** An approval is open: drawers hide and the sidebar shortcuts are off. */
  suspended: boolean
  /** Another dialog is open (the delete confirmation): the sidebar shortcuts are off. */
  blocked?: boolean
  shellRef?: React.Ref<ShellHandle>
  /** The chat column: header, banners and the conversation. */
  children: React.ReactNode
}

const subscribeToResize = (notify: () => void): (() => void) => {
  window.addEventListener('resize', notify)
  return () => {
    window.removeEventListener('resize', notify)
  }
}
const windowWidth = (): number => window.innerWidth

type Drawn = { side: 'left' | 'right'; key: string } | null

/**
 * The two-pane shell: a chats sidebar on the left, the chat in the middle and the
 * Workspace panel on the right. Both panes collapse (header buttons, Ctrl+Alt+[ and
 * ]), resize (drag or arrow keys on the separator) and remember their state. Where
 * the window is too narrow to dock a pane (see layout.ts) its toggle opens it as a
 * drawer instead. The chat column keeps at least 480px.
 */
export function AppShell({
  left,
  right,
  inert,
  suspended,
  blocked = false,
  shellRef,
  children,
}: AppShellProps): React.JSX.Element {
  const { prefs, ready, update } = useLayoutPrefs()
  const width = useSyncExternalStore(subscribeToResize, windowWidth)
  const geometry = computeGeometry(width, prefs)
  const leftId = useId()
  const rightId = useId()

  // A drawer belongs to one window-size situation; any change of it (a breakpoint, or
  // the right pane becoming dockable) closes the drawer. Opening one closes the other.
  const situation = `${geometry.viewport}:${String(geometry.right.dockable)}`
  const [drawn, setDrawn] = useState<Drawn>(null)
  if (drawn && drawn.key !== situation) setDrawn(null)
  const drawer = drawn?.side ?? null

  const closeDrawer = useCallback(() => {
    setDrawn(null)
  }, [])
  useImperativeHandle(shellRef, () => ({ closeDrawer }), [closeDrawer])

  const toggle = (side: 'left' | 'right'): void => {
    if (geometry[side].dockable) {
      if (side === 'left') update({ leftOpen: !prefs.leftOpen })
      else update({ rightOpen: !prefs.rightOpen })
    } else {
      setDrawn(drawer === side ? null : { side, key: situation })
    }
  }
  useLayoutHotkeys(toggle, inert || suspended || blocked)

  // Panes animate between states, but not into the saved state on first paint.
  const [animated, setAnimated] = useState(false)
  useEffect(() => {
    if (!ready) return
    const frame = requestAnimationFrame(() => {
      setAnimated(true)
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [ready])

  const leftResize = useResizablePane({
    side: 'left',
    width: geometry.left.width,
    min: geometry.left.min,
    max: geometry.left.max,
    defaultWidth: LEFT_DEFAULT,
    label: 'Resize chats sidebar',
    onResize: (leftWidth) => {
      update({ leftWidth })
    },
  })
  const rightResize = useResizablePane({
    side: 'right',
    width: geometry.right.width,
    min: geometry.right.min,
    max: geometry.right.max,
    defaultWidth: RIGHT_DEFAULT,
    label: 'Resize workspace panel',
    onResize: (rightWidth) => {
      update({ rightWidth })
    },
  })

  const control = (side: 'left' | 'right'): PaneControl => {
    const pane = geometry[side]
    const visible = pane.dockable ? pane.docked : drawer === side
    return {
      docked: pane.dockable,
      visible,
      toggle: () => {
        toggle(side)
      },
      controlsId:
        pane.dockable || drawer === side ? (side === 'left' ? leftId : rightId) : undefined,
    }
  }
  const value: ShellContextValue = {
    left: control('left'),
    right: control('right'),
    rightTab: prefs.rightTab,
    setRightTab: (rightTab) => {
      update({ rightTab })
    },
    closeDrawer,
  }

  return (
    <ShellContext value={value}>
      <div
        className="app"
        data-animated={animated || undefined}
        data-resizing={leftResize.dragging || rightResize.dragging || undefined}
        style={
          {
            '--sidebar-width-left': `${String(geometry.left.width)}px`,
            '--sidebar-width-right': `${String(geometry.right.width)}px`,
          } as React.CSSProperties
        }
      >
        {geometry.left.dockable && (
          <>
            <aside
              id={leftId}
              className="shell-pane shell-pane-left"
              aria-label="Conversations"
              data-open={geometry.left.docked}
              inert={inert || !geometry.left.docked}
            >
              <div className="shell-pane-inner">{left('docked')}</div>
            </aside>
            {geometry.left.docked && (
              <div
                className="shell-separator"
                data-side="left"
                data-dragging={leftResize.dragging || undefined}
                {...leftResize.separatorProps}
              />
            )}
          </>
        )}
        <main inert={inert} className="workspace-main">
          {children}
        </main>
        {geometry.right.dockable && (
          <>
            {geometry.right.docked && (
              <div
                className="shell-separator"
                data-side="right"
                data-dragging={rightResize.dragging || undefined}
                {...rightResize.separatorProps}
              />
            )}
            <aside
              id={rightId}
              className="shell-pane shell-pane-right"
              aria-label="Workspace"
              data-open={geometry.right.docked}
              inert={inert || !geometry.right.docked}
            >
              <div className="shell-pane-inner">{right('docked')}</div>
            </aside>
          </>
        )}
        {drawer && (
          <div className="shell-drawers" inert={inert}>
            <Drawer
              key={drawer}
              side={drawer}
              id={drawer === 'left' ? leftId : rightId}
              label={drawer === 'left' ? 'Chats' : 'Workspace'}
              closeLabel={drawer === 'left' ? 'Close chats' : 'Close workspace'}
              suspended={suspended}
              onClose={closeDrawer}
            >
              {drawer === 'left' ? left('drawer') : right('drawer')}
            </Drawer>
          </div>
        )}
      </div>
    </ShellContext>
  )
}
