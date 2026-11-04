import { createElement, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { CodeBlock } from './CodeBlock'
import { InlineCode, ReplyLink, textOf, withMentions } from './ReplyLinks'

// Model output is untrusted. react-markdown builds React elements (never
// innerHTML); `skipHtml` drops raw HTML (rehype-raw is deliberately not used),
// the default URL transform strips javascript: and other unsafe links, and
// images are never loaded. GFM adds tables, task lists and strikethrough;
// highlighting only wraps code text in class-named spans.
// Links are drawn by ReplyLink (ReplyLinks.tsx): the real destination shows on hover and focus,
// a link whose text names another site asks first, and a file or folder target is a button only
// when the main process says it is inside a granted folder. Raw `file:` URLs never become links.
const textual = (tag: string, allowWhole: boolean) =>
  // `node` is react-markdown's own prop and must not reach the DOM.
  function Textual({ node: _node, children, ...props }: { node?: unknown; children?: ReactNode }) {
    return createElement(tag, props, withMentions(children, allowWhole))
  }

const components: Components = {
  a: ({ href, children }) => <ReplyLink href={href}>{children}</ReplyLink>,
  // Inline code that is wholly a file or folder name; a fenced block (which has a language
  // class or a line break) is left as it is.
  code: ({ node: _node, className, children, ...props }) => {
    const text = textOf(children)
    if (className !== undefined || text.includes('\n'))
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    return <InlineCode text={text}>{children}</InlineCode>
  },
  p: textual('p', true),
  li: textual('li', true),
  td: textual('td', true),
  th: textual('th', true),
  strong: textual('strong', false),
  em: textual('em', false),
  del: textual('del', false),
  img: ({ alt }) => <span className="md-image">[image{alt ? `: ${alt}` : ''}]</span>,
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  // Task-list checkboxes are display only.
  input: ({ checked, type }) =>
    type === 'checkbox' ? <input type="checkbox" checked={checked} disabled readOnly /> : null,
  // Wide tables scroll inside their own box instead of widening the message.
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
}

// A small set of languages keeps the bundle down; anything else renders plain.
const LANGUAGES = {
  typescript,
  javascript,
  json,
  bash,
  powershell,
  python,
  css,
  xml,
  markdown,
  diff,
  yaml,
}
const ALIASES = {
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx', 'mjs'],
  bash: ['sh', 'shell', 'zsh'],
  powershell: ['ps1', 'pwsh'],
  python: ['py'],
  xml: ['html'],
  markdown: ['md'],
  yaml: ['yml'],
}
const rehypePlugins: NonNullable<Options['rehypePlugins']> = [
  [rehypeHighlight, { languages: LANGUAGES, aliases: ALIASES, ignoreMissing: true }],
]

/**
 * The default transform strips every URL with a scheme but http(s), mailto and the like
 * (javascript:, data:, file:, ...). A Windows drive path (`C:\\Users\\me\\a.txt`) looks like
 * a scheme to it, so it would be dropped; it is kept here as DATA for ReplyLink, which never
 * makes it an `href` and sends it to the main process to check as a file name.
 */
export function urlTransform(url: string, key: string): string {
  const safe = defaultUrlTransform(url)
  if (safe === '' && key === 'href' && /^[A-Za-z]:(?:[\\/]|%5C|%2F)/i.test(url)) return url
  return safe
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
