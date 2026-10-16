import { useCallback, useEffect, useRef, useState } from 'react'
import { activePromptIndex, plainLabel, stepPrompt } from '../turns'
import { SafeText } from './reveal'

export interface RailPrompt {
  id: string
  text: string
}

/** Below this window width the rail would crowd the messages. */
export const RAIL_MIN_WIDTH = 760
const MIN_PROMPTS = 2
const FLASH_MS = 1500
const PREVIEW_CHARS = 240

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function useWideWindow(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= RAIL_MIN_WIDTH)
  useEffect(() => {
    const onResize = (): void => {
      setWide(window.innerWidth >= RAIL_MIN_WIDTH)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return wide
}

/** Ctrl/Cmd+Alt+Up and Down, matched on the physical key; key repeat and AltGraph are ignored. */
export function matchPromptHotkey(
  event: Pick<
    KeyboardEvent,
    'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'defaultPrevented'
  > & { getModifierState?: (key: string) => boolean },
): -1 | 1 | null {
  if (event.defaultPrevented || event.repeat || event.shiftKey || !event.altKey) return null
  if (!(event.ctrlKey || event.metaKey)) return null
  if (event.getModifierState?.('AltGraph')) return null
  if (event.code === 'ArrowUp') return -1
  if (event.code === 'ArrowDown') return 1
  return null
}

/**
 * A strip of ticks down the chat's left edge, one per prompt. The tick for the prompt at
 * the middle of the view is marked; hovering or focusing a tick previews the prompt, and
 * clicking it (or Ctrl+Alt+Up/Down) scrolls to it. `scrollRef` is the scrolling message
 * list, whose prompt rows carry `data-prompt-id`.
 */
export function PromptRail({
  prompts,
  scrollRef,
  disabled,
}: {
  prompts: RailPrompt[]
  scrollRef: React.RefObject<HTMLElement | null>
  /** An approval is open: the keyboard shortcut is off. */
  disabled: boolean
}): React.JSX.Element | null {
  const wide = useWideWindow()
  const [active, setActive] = useState(prompts.length - 1)
  const activeRef = useRef(active)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const count = prompts.length
  const navRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  // The tick being previewed, and where its preview sits (relative to the rail).
  const [preview, setPreview] = useState<{ index: number; top: number } | null>(null)

  const rows = useCallback(
    (): HTMLElement[] =>
      Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-prompt-id]') ?? []),
    [scrollRef],
  )

  // Scroll-spy: the active prompt is the last one that starts above the middle of the list.
  useEffect(() => {
    const list = scrollRef.current
    if (!list || count < MIN_PROMPTS) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const box = list.getBoundingClientRect()
      const next = activePromptIndex(
        rows().map((row) => row.getBoundingClientRect().top),
        box.top + list.clientHeight / 2,
      )
      activeRef.current = next
      setActive(next)
    }
    const schedule = (): void => {
      frame ||= requestAnimationFrame(update)
    }
    update()
    list.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      list.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollRef, rows, count])

  // A long list scrolls inside the rail; keep the active tick in sight.
  useEffect(() => {
    const list = listRef.current
    const tick = list?.children[active] as HTMLElement | undefined
    if (!list || !tick) return
    if (tick.offsetTop < list.scrollTop) list.scrollTop = tick.offsetTop
    else if (tick.offsetTop + tick.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = tick.offsetTop + tick.offsetHeight - list.clientHeight
  }, [active, count, wide])

  const showPreview = (index: number, tick: HTMLElement): void => {
    const nav = navRef.current
    if (!nav) return
    const top = tick.getBoundingClientRect().top - nav.getBoundingClientRect().top
    setPreview({ index, top: top + tick.offsetHeight / 2 })
  }
  const hidePreview = (): void => {
    setPreview(null)
  }

  useEffect(
    () => () => {
      clearTimeout(flashTimer.current)
    },
    [],
  )

  const jumpTo = useCallback(
    (index: number): void => {
      const row = rows()[index]
      if (!row) return
      const motion = !reducedMotion()
      row.scrollIntoView({ block: 'center', behavior: motion ? 'smooth' : 'auto' })
      activeRef.current = index
      setActive(index)
      if (!motion) return
      for (const other of rows()) delete other.dataset.flash
      row.dataset.flash = ''
      clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => {
        delete row.dataset.flash
      }, FLASH_MS)
    },
    [rows],
  )

  useEffect(() => {
    if (disabled || count < MIN_PROMPTS) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const direction = matchPromptHotkey(event)
      if (!direction) return
      event.preventDefault()
      const next = stepPrompt(activeRef.current, count, direction)
      if (next !== null) jumpTo(next)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [disabled, count, jumpTo])

  if (!wide || count < MIN_PROMPTS) return null
  const previewed = preview ? prompts[preview.index] : undefined
  return (
    <nav className="prompt-rail" aria-label="Prompts" ref={navRef}>
      <ol ref={listRef}>
        {prompts.map((prompt, index) => (
          <li key={prompt.id}>
            <button
              type="button"
              className="prompt-tick"
              aria-label={`Jump to prompt ${String(index + 1)} of ${String(count)}: ${plainLabel(prompt.text, 80)}`}
              aria-current={index === active ? 'location' : undefined}
              onClick={() => {
                jumpTo(index)
              }}
              onPointerEnter={(event) => {
                showPreview(index, event.currentTarget)
              }}
              onPointerLeave={hidePreview}
              onFocus={(event) => {
                showPreview(index, event.currentTarget)
              }}
              onBlur={hidePreview}
            />
          </li>
        ))}
      </ol>
      {previewed && preview && (
        <div className="prompt-preview" style={{ top: preview.top }} aria-hidden="true">
          <SafeText text={plainLabel(previewed.text, PREVIEW_CHARS)} />
        </div>
      )}
    </nav>
  )
}
