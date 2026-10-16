import ReactMarkdown, { type Components, type Options } from 'react-markdown'
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

// Model output is untrusted. react-markdown builds React elements (never
// innerHTML); `skipHtml` drops raw HTML (rehype-raw is deliberately not used),
// the default URL transform strips javascript: and other unsafe links, and
// images are never loaded. GFM adds tables, task lists and strikethrough;
// highlighting only wraps code text in class-named spans.
const components: Components = {
  // target=_blank goes through the main process's window-open handler, which
  // opens http(s) links in the default browser and denies everything else.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
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

export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
