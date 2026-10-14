function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file'
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return 'diff-context'
}

/** A unified diff, monospace, one coloured line per diff line. The +/- prefixes stay visible. */
export function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return (
    <pre className="diff scroll-box" tabIndex={0} aria-label="Full diff">
      {lines.map((line, index) => (
        // Lines can repeat, so the index is the only stable key.
        <span key={index} className={`diff-line ${lineClass(line)}`}>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}
