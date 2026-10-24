import { useEffect, useRef, useState } from 'react'
import { useToast } from '../Toast'
import { FILE_DRAG_TYPE } from './drag'

/** Shown over the chat column and message box while files from outside the app are dragged over them. */
export const ATTACH_DROP_HINT = 'Drop to attach'

/** Shown over the Files tab, and as its toast on drop: files are attached from the message box, not the tree. */
export const FILES_TAB_DROP_HINT = 'Drop files on the message box to attach them'

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

interface ExternalDropOptions {
  /**
   * Called with the dropped files. Without it the zone attaches nothing: it shows
   * FILES_TAB_DROP_HINT and a toast on drop (the Files tree is not an attach target).
   */
  onFiles?: (files: File[]) => void
}

/**
 * Files dragged in from outside: a hint overlay while hovering, then `onFiles` with the
 * dropped files (or, without it, a toast pointing to the message box). Spread `zoneProps`
 * on the element that receives the drag and render `hint` inside it (it must be positioned).
 * Every other drag, including the tree-to-composer token and chat drag and drop, is left alone.
 */
export function useExternalFileDrop({ onFiles }: ExternalDropOptions = {}) {
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
      if (onFiles) onFiles(Array.from(event.dataTransfer.files))
      else notify(FILES_TAB_DROP_HINT)
    },
  }

  const hint = over ? (
    <div className="external-drop-hint" aria-hidden="true" data-testid="external-drop-hint">
      <p>{onFiles ? ATTACH_DROP_HINT : FILES_TAB_DROP_HINT}</p>
    </div>
  ) : null

  return { zoneProps, hint }
}
