import { fileKind } from './file-kind'

/** The mark inside the page outline, one distinct shape per type (colour is never the only cue). */
const MARKS: Record<string, React.ReactNode> = {
  doc: <path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" />,
  sheet: <path d="M5 7.5h6v4.5H5zM5 9.75h6M8 7.5V12" />,
  slide: <path d="M5 7.5h6v3.5H5zM8 11v1.5" />,
  pdf: <path d="M5.5 12V8h1.5a1.2 1.2 0 0 1 0 2.4H5.5M9.5 12V8M9.5 8h1.5M9.5 10h1.2" />,
  code: <path d="M6.5 8 5 9.75 6.5 11.5M9.5 8 11 9.75 9.5 11.5" />,
  image: <path d="M5 12l2-2.5 1.5 1.5 1-1L11 12zM10 7.6a.6.6 0 1 0 0 .01" />,
  media: <path d="M6.75 7.5v4.5l3.75-2.25z" />,
  archive: <path d="M8 3.5v1M8 5.5v1M8 7.5v1M7 9.5h2v2H7z" />,
  other: null,
}

/**
 * A 16px file or folder glyph. Files are coloured by type (`ft-<kind>` classes use
 * the --color-ft-* tokens) and carry a type-specific mark; folders, links and
 * locked entries have their own shapes. Decorative: rows say what they are in text.
 */
export function FileIcon({
  name,
  kind,
  open = false,
  locked = false,
}: {
  name: string
  kind: 'file' | 'dir' | 'link' | 'other'
  open?: boolean
  locked?: boolean
}): React.JSX.Element {
  let className = 'file-icon'
  let body: React.ReactNode
  if (locked) {
    className += ' file-icon-locked'
    body = <path d="M5 7.5h6v5H5zM6.25 7.5V6a1.75 1.75 0 0 1 3.5 0v1.5M8 9.5v1.25" />
  } else if (kind === 'dir') {
    className += ' file-icon-folder'
    body = open ? (
      <path d="M2 12.5V4.5h4l1.25 1.5H13v1.5M2 12.5l1.5-5h11l-1.5 5z" />
    ) : (
      <path d="M2 12.5v-8h4l1.25 1.5H14v6.5z" />
    )
  } else if (kind === 'link') {
    className += ' file-icon-link'
    body = <path d="M3.5 3.5h9v9h-9zM6.5 9.5l3-3M7 6.5h2.5V9" />
  } else {
    const type = fileKind(name)
    className += ` ft-${type}`
    body = (
      <>
        <path d="M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3" />
        {MARKS[type]}
      </>
    )
  }
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {body}
    </svg>
  )
}
