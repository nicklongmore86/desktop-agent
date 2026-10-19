import { useEffect, useRef, useState } from 'react'
import { useToast } from '../Toast'
import { FILE_DRAG_TYPE } from './drag'

/** Shown over a drop zone while files from outside the app are dragged over it, and as the toast on drop. */
export const EXTERNAL_DROP_MESSAGE =
  'Attaching files from outside the app is coming. For now, add the folder in Settings → Folders, or drag from the Files panel.'

/**
 * True for a drag of files from outside the app. Only the drag's type list is
 * read (the files themselves are never touched), and the app's own tree drag,
 * which carries a private token, is excluded.
 */
export function isExternalFileDrag(data: DataTransfer | null): boolean {
  if (!data) return false
  const types = Array.from(data.types)
  return types.includes('Files') && !types.includes(FILE_DRAG_TYPE)
}

/**
 * Feedback for files dragged in from outside: a hint overlay while hovering and a
 * toast on drop. Nothing is attached, read or inserted. Spread `zoneProps` on the
 * element that receives the drag and render `hint` inside it (it must be positioned).
 * Every other drag, including the tree-to-composer token and chat drag and drop, is left alone.
 */
export function useExternalFileDrop() {
  const notify = useToast()
  const [over, setOver] = useState(false)
  const overRef = useRef(false)
  const set = (value: boolean): void => {
    overRef.current = value
    setOver(value)
  }

  // A drag that ends elsewhere (or is cancelled) must not leave the hint up.
  useEffect(() => {
    const clear = (): void => {
      if (overRef.current) {
        overRef.current = false
        setOver(false)
      }
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  const accept = (event: React.DragEvent): boolean => {
    if (!isExternalFileDrag(event.dataTransfer)) return false
    // Accept the drag so `drop` fires (and the browser never navigates to the file); then refuse inside it.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    return true
  }

  const zoneProps = {
    onDragEnter: (event: React.DragEvent) => {
      if (accept(event)) set(true)
    },
    onDragOver: (event: React.DragEvent) => {
      if (accept(event) && !overRef.current) set(true)
    },
    onDragLeave: (event: React.DragEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && event.currentTarget.contains(next)) return
      set(false)
    },
    onDrop: (event: React.DragEvent) => {
      if (!accept(event)) return
      set(false)
      notify(EXTERNAL_DROP_MESSAGE)
    },
  }

  const hint = over ? (
    <div className="external-drop-hint" aria-hidden="true" data-testid="external-drop-hint">
      <p>{EXTERNAL_DROP_MESSAGE}</p>
    </div>
  ) : null

  return { zoneProps, hint }
}
