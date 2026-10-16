import { useRef, useState } from 'react'
import { RESIZE_STEP, clamp } from './layout'

export interface ResizablePaneOptions {
  /** The pane the separator sits beside: dragging towards the chat shrinks the right pane, grows the left one. */
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  defaultWidth: number
  label: string
  /** Called with each new width, already inside [min, max]. */
  onResize: (width: number) => void
}

/**
 * Props for a focusable vertical separator that resizes a pane: drag with the mouse
 * (pointer capture, so it keeps tracking outside the 4px handle), or use the keyboard
 * (arrows move 16px, Home/End go to the limits, double-click resets).
 */
export function useResizablePane({
  side,
  width,
  min,
  max,
  defaultWidth,
  label,
  onResize,
}: ResizablePaneOptions) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // Moving right grows the left pane and shrinks the right one.
  const direction = side === 'left' ? 1 : -1

  const end = (): void => {
    drag.current = null
    setDragging(false)
  }

  return {
    dragging,
    separatorProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-label': label,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-valuenow': width,
      tabIndex: 0,
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { startX: event.clientX, startWidth: width }
        setDragging(true)
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        const start = drag.current
        if (!start) return
        onResize(clamp(start.startWidth + direction * (event.clientX - start.startX), min, max))
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onDoubleClick: () => {
        onResize(clamp(defaultWidth, min, max))
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        let next: number
        if (event.key === 'ArrowRight') next = width + direction * RESIZE_STEP
        else if (event.key === 'ArrowLeft') next = width - direction * RESIZE_STEP
        else if (event.key === 'Home') next = min
        else if (event.key === 'End') next = max
        else return
        event.preventDefault()
        onResize(clamp(next, min, max))
      },
    },
  }
}
