// Links and file names in a chat reply. The reply is untrusted, so:
//  - a web link shows where it REALLY goes (on hover and on keyboard focus), in strict
//    left-to-right order with hidden, direction and look-alike characters made visible, and
//    asks first when its text claims a different site (the main process still opens nothing
//    but http(s));
//  - a file or folder named in a reply is clickable only when MAIN says it is inside a granted
//    folder and what a click will do. The renderer only proposes the text (mentions.ts).
// Nothing here opens anything while an approval is showing.
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { MentionResolution } from '../../../shared/ipc-files'
import { ApiContext } from '../api'
import { displayUrl, misleadingHost, webDestination } from '../links'
import { openMention, resolveMention, splitMentions, type TextPart } from '../mentions'
import { plainTitle, SafeText } from './reveal'
import { useToast } from './Toast'

/** True while an approval is open: nothing in a reply may open anything then. */
const SuspendedContext = createContext(false)
/** True inside a link, where another clickable would nest one inside the other. */
const InsideLinkContext = createContext(false)

export function LinksSuspended({
  suspended,
  children,
}: {
  suspended: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return <SuspendedContext value={suspended}>{children}</SuspendedContext>
}

/** The text a React node tree shows. */
export function textOf(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/** A line under a link or file name saying what a click does; shown on hover and on focus. */
function Hint({ id, children }: { id: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <span id={id} role="tooltip" className="link-dest">
      {children}
    </span>
  )
}

// ---- Web links --------------------------------------------------------------------------

function ExternalLinkDialog({
  text,
  href,
  host,
  suspended,
  onCancel,
  onConfirm,
}: {
  text: string
  href: string
  host: string
  suspended: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const titleId = useId()
  const textId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (!suspended) cancel.current?.focus()
  }, [suspended])
  return createPortal(
    <div className="modal-backdrop" hidden={suspended} inert={suspended}>
      <div
        ref={dialog}
        className="confirm-dialog link-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key !== 'Tab') return
          const buttons = [...(dialog.current?.querySelectorAll<HTMLElement>('button') ?? [])]
          const first = buttons[0]
          const last = buttons.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <h2 id={titleId}>Open this link in your browser?</h2>
        <div id={textId}>
          <p>The link says:</p>
          <p className="link-confirm-value">
            <SafeText text={text} />
          </p>
          <p>It goes to:</p>
          <p className="link-confirm-value" aria-label="Real destination">
            <SafeText text={displayUrl(href)} />
          </p>
          <p>
            Site: <strong>{host}</strong>
          </p>
        </div>
        <div className="approval-actions">
          <button ref={cancel} type="button" className="button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button-primary" onClick={onConfirm}>
            Open in browser
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** A web link: destination on hover and focus, and a question when its text says another site. */
function WebLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}): React.JSX.Element {
  const suspended = useContext(SuspendedContext)
  const hintId = useId()
  const [asking, setAsking] = useState(false)
  const text = textOf(children)
  const destination = webDestination(href)
  const claimed = destination ? misleadingHost(text, destination.host) : null
  const hold = (event: React.MouseEvent): void => {
    // The check happens before anything opens; the main process then applies its own
    // http(s) rule to whatever the page asks for.
    if (suspended || claimed !== null) event.preventDefault()
  }
  return (
    <span className="link-wrap">
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        aria-describedby={hintId}
        data-mismatch={claimed !== null ? 'true' : undefined}
        onClick={(event) => {
          hold(event)
          if (!suspended && claimed !== null) setAsking(true)
        }}
        onAuxClick={hold}
      >
        <InsideLinkContext value>{children}</InsideLinkContext>
      </a>
      <Hint id={hintId}>
        <span className="link-dest-label">{destination ? 'Goes to' : 'Link'}</span>
        <SafeText text={displayUrl(href)} />
        {destination && (
          <span className="link-dest-site">
            Site: <strong>{destination.host}</strong>
          </span>
        )}
        {claimed !== null && (
          <span className="link-dest-warning">
            The link text says {claimed}. It asks before opening.
          </span>
        )}
      </Hint>
      {asking && destination && (
        <ExternalLinkDialog
          text={text}
          href={href}
          host={destination.host}
          suspended={suspended}
          onCancel={() => {
            setAsking(false)
          }}
          onConfirm={() => {
            setAsking(false)
            // The window-open handler in main opens http(s) in the browser and denies the rest.
            window.open(href, '_blank', 'noopener,noreferrer')
          }}
        />
      )}
    </span>
  )
}

// ---- Files and folders --------------------------------------------------------------------

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

function describeClick(resolution: Extract<MentionResolution, { ok: true }>): string {
  return resolution.action === 'open'
    ? resolution.kind === 'dir'
      ? 'Open folder'
      : 'Open'
    : 'Show in Explorer'
}

/**
 * Text that may name a file or folder. Plain text until main says it is one inside a granted
 * folder; then a button that opens or shows it. `fallback` is shown when it is not.
 */
function PathMention({
  proposal,
  label,
  fallback,
}: {
  proposal: string
  label: React.ReactNode
  fallback: React.ReactNode
}): React.JSX.Element {
  const suspended = useContext(SuspendedContext)
  const notify = useToast()
  const api = useContext(ApiContext)
  const hintId = useId()
  const [resolution, setResolution] = useState<MentionResolution | null>(null)
  useEffect(() => {
    if (!api) return
    let live = true
    void resolveMention(api, proposal).then((answer) => {
      if (live) setResolution(answer)
    })
    return () => {
      live = false
    }
  }, [api, proposal])
  if (!api || resolution === null || !resolution.ok) return <>{fallback}</>

  const activate = async (): Promise<void> => {
    if (suspended) return
    // Main decides again with the grants as they are now.
    const result = await openMention(api, proposal)
    if (result.ok) {
      const name = plainTitle(baseName(result.path))
      if (result.action === 'open') notify(`Opened ${name}`)
      else
        notify(`Shown in Explorer, not opened: ${name}. ${result.note ?? ''}`.trim(), {
          label: 'OK',
          onClick: () => {},
        })
    } else {
      setResolution({ ok: false })
      notify(plainTitle(result.reason), { label: 'OK', onClick: () => {} })
    }
  }
  return (
    <span className="link-wrap">
      <button
        type="button"
        className="path-mention"
        aria-describedby={hintId}
        aria-disabled={suspended || undefined}
        onClick={() => {
          void activate()
        }}
      >
        {label}
      </button>
      <Hint id={hintId}>
        <span className="link-dest-label">{describeClick(resolution)}</span>
        <SafeText text={resolution.path} />
        {resolution.note && <span className="link-dest-warning">{resolution.note}</span>}
      </Hint>
    </span>
  )
}

function Parts({ parts }: { parts: TextPart[] }): React.JSX.Element {
  return (
    <>
      {parts.map((part, index) =>
        part.mention === undefined ? (
          part.text
        ) : (
          <PathMention
            key={index}
            proposal={part.mention}
            label={<SafeText text={part.text} />}
            fallback={part.alt ? <Parts parts={part.alt} /> : part.text}
          />
        ),
      )}
    </>
  )
}

/** A piece of reply text with the file and folder names in it made clickable (when main agrees). */
export function MentionText({
  text,
  whole = false,
}: {
  text: string
  whole?: boolean
}): React.JSX.Element {
  const inLink = useContext(InsideLinkContext)
  const parts = useMemo(
    () => (inLink ? [{ text }] : splitMentions(text, whole)),
    [text, whole, inLink],
  )
  return <Parts parts={parts} />
}

/**
 * The children of a paragraph, list item, table cell or emphasis, with each text child run
 * through MentionText. `whole` marks a child that is the element's only content.
 */
export function withMentions(children: React.ReactNode, allowWhole: boolean): React.ReactNode {
  const list = Children.toArray(children)
  const only = list.length === 1 && typeof list[0] === 'string'
  return list.map((child, index) =>
    typeof child === 'string' ? (
      <MentionText key={index} text={child} whole={allowWhole && only} />
    ) : (
      child
    ),
  )
}

/** Inline code: a button when the whole code is a file or folder main accepts, else as it was. */
export function InlineCode({
  text,
  children,
}: {
  text: string
  children: React.ReactNode
}): React.JSX.Element {
  const inLink = useContext(InsideLinkContext)
  const parts = useMemo(() => (inLink ? [] : splitMentions(text, true)), [text, inLink])
  const only = parts.length === 1 ? parts[0] : undefined
  const proposal = only?.mention
  if (proposal === undefined) return <code>{children}</code>
  return (
    <PathMention
      proposal={proposal}
      label={
        <code>
          <SafeText text={text} />
        </code>
      }
      fallback={<code>{children}</code>}
    />
  )
}

const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
// The Markdown parser percent-encodes a backslash in a link target, so `C:\a` arrives as `C:%5Ca`.
const WINDOWS_PATH = /^[A-Za-z]:(?:[\\/]|%5C|%2F)/i

/**
 * What a Markdown link target is: a web link, a file or folder name (a relative path, or a
 * Windows drive path, which the Markdown settings keep as plain data and never as a URL), or
 * nothing clickable (a fragment, mailto:, or anything else).
 */
export function linkKind(href: string | undefined): 'web' | 'path' | 'none' {
  if (href === undefined || href === '') return 'none'
  if (WINDOWS_PATH.test(href)) return 'path'
  if (/^https?:/i.test(href)) return 'web'
  if (HAS_SCHEME.test(href) || href.startsWith('#') || href.startsWith('//')) return 'none'
  return 'path'
}

function decoded(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/** The Markdown `a` element. */
export function ReplyLink({
  href,
  children,
}: {
  href?: string | undefined
  children?: React.ReactNode
}): React.JSX.Element {
  const kind = linkKind(href)
  if (href === undefined || kind === 'none') {
    // Not a destination anything can open (mailto:, a fragment): the main process denies it
    // anyway, so show the text without a link and keep the target readable.
    return (
      <span className="link-wrap">
        <InsideLinkContext value>{children}</InsideLinkContext>
        {href !== undefined && href !== '' && (
          <span className="link-dest-inline">
            {' ('}
            <SafeText text={href} />
            {')'}
          </span>
        )}
      </span>
    )
  }
  if (kind === 'path') {
    const proposal = decoded(href)
    const label = textOf(children)
    return (
      <PathMention
        proposal={proposal}
        label={<SafeText text={label === '' ? proposal : label} />}
        fallback={
          <span className="link-wrap">
            <InsideLinkContext value>{children}</InsideLinkContext>
            <span className="link-dest-inline">
              {' ('}
              <SafeText text={href} />
              {')'}
            </span>
          </span>
        }
      />
    )
  }
  return <WebLink href={href}>{children}</WebLink>
}
