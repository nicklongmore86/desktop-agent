import { effectiveBudget, type DocumentLimits } from './limits'
import { MIME } from './sniff'
import { DocumentError, type DocumentKind, type DocumentView, type ExtractOptions } from './types'

/** One block of a flowing document: blocks are joined by a blank line, list items by a newline. */
export interface TextBlock {
  text: string
  kind: 'heading' | 'paragraph' | 'list' | 'table'
  /** A table's cells, for flattening it inside another table. */
  rows?: string[][]
}
export type TextBlocks = TextBlock[]

/** The blocks as one text. */
export function joinBlocks(blocks: TextBlocks): string {
  let out = ''
  let previous: TextBlock['kind'] | undefined
  for (const block of blocks) {
    if (previous !== undefined) out += previous === 'list' && block.kind === 'list' ? '\n' : '\n\n'
    out += block.text
    previous = block.kind
  }
  return out
}

/**
 * A view of a flowing document's text (Word, OpenDocument text, old .doc) from character
 * `select.from` (1-based) within the text budget. A cut that is not at the end moves back
 * to the last line break in the second half of the window, so blocks are not split.
 */
export function textView(
  kind: DocumentKind,
  content: TextBlocks | string,
  options: ExtractOptions,
  limits: DocumentLimits,
): DocumentView {
  const text = typeof content === 'string' ? content : joinBlocks(content)
  const total = text.length
  const view: DocumentView = {
    meta: { kind, mime: MIME[kind] },
    sections: [],
    images: [],
    position: { unit: 'char', total, shown: { from: 0, to: 0 }, next: null },
    warnings: [],
  }
  if (total === 0) {
    view.warnings.push('The document has no text.')
    return view
  }
  const from = Math.max(1, Math.floor(options.select?.from ?? 1))
  if (from > total) {
    throw new DocumentError(
      'out-of-range',
      `Character ${String(from)} is past the end; the text has ${String(total)} characters.`,
    )
  }
  const { maxChars } = effectiveBudget(options.budget, limits)
  let to = Math.min(
    total,
    from - 1 + maxChars,
    Math.max(from, Math.floor(options.select?.to ?? total)),
  )
  if (to < total && to < (options.select?.to ?? Infinity)) {
    const cut = text.lastIndexOf('\n', to - 1)
    if (cut >= from - 1 + Math.floor((to - from + 1) / 2)) to = cut + 1
  }
  view.position = { unit: 'char', total, shown: { from, to }, next: to < total ? to + 1 : null }
  view.sections.push({ text: text.slice(from - 1, to) })
  return view
}
