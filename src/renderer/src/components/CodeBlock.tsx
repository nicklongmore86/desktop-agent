import { useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import { copyText } from '../clipboard'
import { splitMentions } from '../mentions'
import { MentionText } from './ReplyLinks'
import { useToast } from './Toast'

type Element = NonNullable<ExtraProps['node']>
type ElementContent = Element['children'][number]

/** The plain source text under a hast node: highlighting spans add no characters. */
function sourceText(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value
  if (node.type !== 'element') return ''
  return node.children.map(sourceText).join('')
}

function languageOf(node: Element): string | null {
  const code = node.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code',
  )
  const classes = code?.properties['className']
  const match = Array.isArray(classes)
    ? classes.map(String).find((name) => name.startsWith('language-'))
    : undefined
  return match ? match.slice('language-'.length) : null
}

/** The lines of a plain listing, or null when none of its first lines could be a file or folder. */
function listingLines(source: string): string[] | null {
  const lines = source.replace(/\n$/, '').split('\n').slice(0, 300)
  return lines.some((line) => splitMentions(line, true).some((part) => part.mention !== undefined))
    ? lines
    : null
}

/** A fenced code block: language label and a Copy button that copies the raw source, not HTML. */
export function CodeBlock({
  node,
  children,
}: {
  node?: Element | undefined
  children?: React.ReactNode
}): React.JSX.Element {
  const notify = useToast()
  const [copied, setCopied] = useState(false)
  const language = node ? languageOf(node) : null

  const copy = async (): Promise<void> => {
    const raw = node ? sourceText(node).replace(/\n$/, '') : ''
    if (await copyText(raw)) {
      setCopied(true)
      notify('Copied')
      setTimeout(() => {
        setCopied(false)
      }, 1500)
    } else notify('Could not copy')
  }

  // A plain listing (no language) with file or folder names in it: each line may be one. A
  // block with a language is code and stays as it is.
  const listing =
    node && (language === null || ['text', 'txt', 'plaintext'].includes(language))
      ? listingLines(sourceText(node))
      : null

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-language">{language ?? 'text'}</span>
        <button
          type="button"
          className="code-block-copy"
          aria-label="Copy code"
          onClick={() => {
            void copy()
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        {listing ? (
          <code>
            {listing.map((line, index) => (
              <span key={index}>
                <MentionText text={line} whole />
                {'\n'}
              </span>
            ))}
          </code>
        ) : (
          children
        )}
      </pre>
    </div>
  )
}
