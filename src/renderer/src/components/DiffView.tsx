import { leadingText, SafeLines, type RevealedLine } from './reveal'

function lineClass(line: RevealedLine): string {
  const text = leadingText(line)
  if (text.startsWith('+++') || text.startsWith('---')) return 'diff-line diff-file'
  if (text.startsWith('@@')) return 'diff-line diff-hunk'
  if (text.startsWith('+')) return 'diff-line diff-add'
  if (text.startsWith('-')) return 'diff-line diff-del'
  return 'diff-line diff-context'
}

/**
 * A unified diff, monospace, one coloured line per diff line. The +/- prefixes
 * stay visible, and hidden or control characters are shown as tokens.
 */
export function DiffView({ diff }: { diff: string }): React.JSX.Element {
  return (
    <pre className="diff scroll-box untrusted-block" tabIndex={0} aria-label="Full diff" dir="ltr">
      <SafeLines text={diff} lineClass={lineClass} />
    </pre>
  )
}
