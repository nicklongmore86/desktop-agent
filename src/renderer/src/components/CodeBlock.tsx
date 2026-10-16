import { useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import { copyText } from '../clipboard'
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
      <pre>{children}</pre>
    </div>
  )
}
