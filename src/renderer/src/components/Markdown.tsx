import ReactMarkdown, { type Components } from 'react-markdown'

// Model output is untrusted. react-markdown builds React elements (never
// innerHTML); `skipHtml` drops raw HTML, the default URL transform strips
// javascript: and other unsafe links, and images are never loaded.
const components: Components = {
  // target=_blank goes through the main process's window-open handler, which
  // opens http(s) links in the default browser and denies everything else.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="md-image">[image{alt ? `: ${alt}` : ''}]</span>,
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
