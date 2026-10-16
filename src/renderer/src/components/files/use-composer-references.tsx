import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FileSearchHit } from '../../../../shared/ipc-files'
import { useApi } from '../../api'
import { useToast } from '../Toast'
import { isFileDrag, takeFileDrop } from './drag'
import { FileIcon } from './FileIcon'
import { useFileReferenceTarget, useInsertFileReference } from './file-references'

/** How long typing pauses before the `@` menu searches. */
export const MENTION_SEARCH_DELAY = 120

/** `@` at the start or after a space, then the query typed so far (no spaces or quotes). */
const MENTION = /(?:^|\s)@([^\s@"]{0,64})$/

interface Mention {
  /** Where the `@` is in the draft. */
  start: number
  query: string
}

/**
 * File references in the message box: the `@` mention menu, dropping an entry
 * dragged from the Files tree, and receiving "Insert reference into chat" from
 * the tree's menu. Each reference is text main resolved (`@"C:\…\file"`), put at
 * the caret; nothing is attached and no file is moved or copied.
 *
 * Returns the props the textarea needs and the menu to render beside it.
 */
export function useComposerReferences({
  draft,
  onDraft,
  inputRef,
}: {
  draft: string
  onDraft: (text: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const api = useApi()
  const notify = useToast()
  const insertReference = useInsertFileReference()
  const listId = useId()
  const [mention, setMention] = useState<Mention | null>(null)
  const [found, setFound] = useState<{ query: string; hits: FileSearchHit[] } | null>(null)
  const [active, setActive] = useState(0)

  /** Replaces draft[from, to) with `text`, spaced from its neighbours, and puts the caret after it. */
  const replaceRange = (text: string, from: number, to: number): void => {
    const value = inputRef.current?.value ?? draft
    const before = value.slice(0, from)
    const after = value.slice(to)
    const lead = before === '' || /\s$/.test(before) ? '' : ' '
    const trail = /^\s/.test(after) ? '' : ' '
    const caret = before.length + lead.length + text.length + trail.length
    pendingCaret.current = caret
    onDraft(`${before}${lead}${text}${trail}${after}`)
  }

  // Place the caret as the new text commits, before any further typing lands.
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    const element = inputRef.current
    if (caret === null || !element) return
    pendingCaret.current = null
    element.focus()
    element.setSelectionRange(caret, caret)
  }, [draft, inputRef])

  useFileReferenceTarget((text) => {
    const element = inputRef.current
    const from = element?.selectionStart ?? draft.length
    replaceRange(text, from, element?.selectionEnd ?? from)
  })

  const close = (): void => {
    setMention(null)
    setActive(0)
  }

  /** Opens, updates or closes the menu from the text before the caret. */
  const detect = (element: HTMLTextAreaElement): void => {
    const caret = element.selectionStart
    const match =
      caret === element.selectionEnd ? MENTION.exec(element.value.slice(0, caret)) : null
    if (!match) {
      if (mention) close()
      return
    }
    const query = match[1] ?? ''
    if (mention?.query !== query) setActive(0)
    setMention({ start: caret - query.length - 1, query })
  }

  const query = mention?.query ?? null
  // The results shown are the ones for the current query; anything else is still searching.
  const hits = query && found?.query === query ? found.hits : []
  const searching = Boolean(query) && found?.query !== query
  useEffect(() => {
    if (!query) return
    let live = true
    const timer = setTimeout(() => {
      api.files.search(query).then(
        (results) => {
          if (live) setFound({ query, hits: results })
        },
        () => {
          if (live) setFound({ query, hits: [] })
        },
      )
    }, MENTION_SEARCH_DELAY)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, query])

  const choose = async (hit: FileSearchHit): Promise<void> => {
    const at = mention
    const element = inputRef.current
    close()
    if (!at || !element) return
    const end = element.selectionStart
    let result
    try {
      result = await api.files.reference({ rootId: hit.rootId, rel: hit.rel })
    } catch {
      result = { ok: false as const, reason: 'Could not add the reference.' }
    }
    if (!result.ok) {
      notify(result.reason)
      return
    }
    replaceRange(result.text, at.start, Math.max(end, at.start + 1 + at.query.length))
  }

  const open = mention !== null
  const optionId = (index: number) => `${listId}-option-${String(index)}`

  /** Handles the menu's keys first; true when the key was used (the caller skips its own). */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return true
    }
    if (hits.length === 0) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (current + step + hits.length) % hits.length)
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const hit = hits[active]
      if (!hit) return false
      event.preventDefault()
      void choose(hit)
      return true
    }
    return false
  }

  const textareaProps = {
    'aria-autocomplete': 'list' as const,
    'aria-expanded': open,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open && hits[active] ? optionId(active) : undefined,
    onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      detect(event.currentTarget)
    },
    onBlur: () => {
      close()
    },
    onDragOver: (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (isFileDrag(event.dataTransfer)) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'link'
      } else if (event.dataTransfer.types.includes('Files')) {
        // Files from outside the app are never attached or opened.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'none'
      }
    },
    onDrop: (event: React.DragEvent<HTMLTextAreaElement>) => {
      const location = takeFileDrop(event.dataTransfer)
      if (location) {
        event.preventDefault()
        void insertReference(location)
      } else if (event.dataTransfer.types.includes('Files')) {
        event.preventDefault()
        notify('Drag files from the Files panel. Add their folder first.')
      }
    },
  }

  const menu = open ? (
    <div className="mention-menu">
      <ul id={listId} role="listbox" aria-label="Files to reference">
        {hits.map((hit, index) => (
          <li
            key={`${hit.rootId}/${hit.rel}`}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            onMouseDown={(event) => {
              // Keep the caret in the message box.
              event.preventDefault()
            }}
            onClick={() => {
              void choose(hit)
            }}
          >
            <FileIcon name={hit.name} kind={hit.kind} />
            <span className="mention-name">{hit.name}</span>
            <span className="mention-path">
              {hit.rootName}/{hit.rel}
            </span>
          </li>
        ))}
      </ul>
      {hits.length === 0 && (
        <p className="mention-hint" role="status">
          {query === ''
            ? 'Type a file name to search your granted folders'
            : searching
              ? 'Searching…'
              : 'No matching files in your granted folders'}
        </p>
      )}
    </div>
  ) : null

  return { onKeyDown, onInput: detect, textareaProps, menu }
}
