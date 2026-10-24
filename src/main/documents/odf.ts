import { markdownTable } from './docx'
import type { DocumentLimits } from './limits'
import type { OfficePackage } from './package'
import { readSlides, slideView } from './pptx'
import { textView, type TextBlocks } from './text-view'
import { DocumentError, type DocumentView, type ExtractOptions } from './types'
import { child, elements, find, textOf, type XmlElement } from './xml'

/**
 * OpenDocument text (.odt) and presentations (.odp), from content.xml with the same
 * package and XML guards as OOXML. Text reads like a Word document (headings, lists,
 * Markdown tables, character positions); a presentation reads slide by slide with its
 * notes. Spreadsheets (.ods) go through SheetJS with the workbooks (sheets.ts).
 */

const KEEP = new Set([
  'office:body',
  'office:text',
  'office:presentation',
  'text:h',
  'text:p',
  'text:list',
  'text:list-item',
  'text:list-header',
  'text:s',
  'text:tab',
  'text:line-break',
  'table:table',
  'table:table-row',
  'table:table-cell',
  'table:covered-table-cell',
  'draw:page',
  'draw:frame',
  'draw:text-box',
  'draw:image',
  'draw:custom-shape',
  'svg:title',
  'svg:desc',
  'presentation:notes',
])
const SKIP = new Set([
  'office:automatic-styles',
  'office:font-face-decls',
  'office:scripts',
  'office:forms',
  'office:annotation',
  'text:note',
  'text:tracked-changes',
  'text:sequence-decls',
  'table:table-column',
  'table:table-columns',
  'table:table-header-columns',
])
const keep = (name: string): boolean | 'skip' => (SKIP.has(name) ? 'skip' : KEEP.has(name))
const TEXT = new Set(['text:h', 'text:p', 'svg:title', 'svg:desc'])
/** Repeated rows and cells (a whole empty sheet column is one element) are expanded this far. */
const MAX_REPEAT = 256
const MAX_TABLE_CELLS = 100_000

export async function extractOdf(
  pkg: OfficePackage,
  kind: 'odt' | 'odp',
  options: ExtractOptions,
  limits: DocumentLimits,
): Promise<DocumentView> {
  const content = await pkg.xml('content.xml', { keep, text: TEXT })
  const body = find(content ?? undefined, 'office:body')
  if (!body) throw new DocumentError('malformed', 'The OpenDocument file has no content.')
  let view: DocumentView
  if (kind === 'odt') {
    const writer = new Writer()
    writer.blocks(find(body, 'office:text'))
    view = textView('odt', writer.out, options, limits)
    if (writer.images > 0) {
      view.warnings.push(
        `The document has ${String(writer.images)} image(s); they are not shown, only marked [Image] with any alt text.`,
      )
    }
  } else {
    const pages = elements(find(body, 'office:presentation'), 'draw:page')
    view = slideView('odp', pages.length)
    await readSlides(view, options, limits, (number) =>
      Promise.resolve(readPage(pages[number - 1])),
    )
  }
  await metaProperties(pkg, view.meta)
  return view
}

async function metaProperties(pkg: OfficePackage, meta: DocumentView['meta']): Promise<void> {
  const root = await pkg.xml('meta.xml', {
    keep: (name) =>
      [
        'office:document-meta',
        'office:meta',
        'dc:title',
        'dc:creator',
        'meta:initial-creator',
      ].includes(name),
  })
  const title = textOf(find(root ?? undefined, 'dc:title')).trim()
  const author = (
    textOf(find(root ?? undefined, 'meta:initial-creator')) ||
    textOf(find(root ?? undefined, 'dc:creator'))
  ).trim()
  if (title) meta.title = title.slice(0, 500)
  if (author) meta.author = author.slice(0, 500)
}

class Writer {
  readonly out: TextBlocks = []
  images = 0

  blocks(parent: XmlElement | undefined, depth = 0): void {
    for (const node of elements(parent)) {
      switch (node.name) {
        case 'text:h': {
          const text = this.inline(node).trim()
          const level = Math.min(9, Math.max(1, Number(node.attrs['text:outline-level'] ?? 1) || 1))
          if (text) this.out.push({ text: `${'#'.repeat(level)} ${text}`, kind: 'heading' })
          break
        }
        case 'text:p': {
          const text = this.inline(node).replace(/\s+$/, '')
          if (text.trim()) this.out.push({ text, kind: 'paragraph' })
          this.frames(node)
          break
        }
        case 'text:list':
          this.list(node, depth)
          break
        case 'table:table': {
          const rows = this.table(node)
          this.out.push({ text: markdownTable(rows), kind: 'table', rows })
          break
        }
        default:
          this.blocks(node, depth)
      }
    }
  }

  private list(list: XmlElement, depth: number): void {
    for (const item of elements(list)) {
      if (item.name !== 'text:list-item' && item.name !== 'text:list-header') continue
      let first = true
      for (const node of elements(item)) {
        if (node.name === 'text:list') {
          this.list(node, depth + 1)
        } else if (node.name === 'text:p' || node.name === 'text:h') {
          const text = this.inline(node).trim()
          if (!text) continue
          const indent = '  '.repeat(Math.min(depth, 8))
          this.out.push({ text: `${indent}${first ? '- ' : '  '}${text}`, kind: 'list' })
          first = false
        } else {
          this.blocks(node, depth + 1)
        }
      }
    }
  }

  /** Text boxes in frames anchored in a paragraph follow it. */
  private frames(paragraph: XmlElement): void {
    for (const node of elements(paragraph)) {
      if (node.name === 'draw:frame' || node.name === 'draw:custom-shape') {
        for (const box of elements(node, 'draw:text-box')) this.blocks(box)
      }
    }
  }

  private inline(element: XmlElement): string {
    let out = ''
    for (const node of element.children) {
      if (typeof node === 'string') {
        // Runs of spaces are written as text:s; plain whitespace collapses.
        out += node.replace(/[ \t\r\n]+/g, ' ')
        continue
      }
      switch (node.name) {
        case 'text:s':
          out += ' '.repeat(Math.min(1000, Math.max(1, Number(node.attrs['text:c'] ?? 1) || 1)))
          break
        case 'text:tab':
          out += '\t'
          break
        case 'text:line-break':
          out += '\n'
          break
        case 'draw:frame': {
          const image = child(node, 'draw:image')
          if (image) {
            this.images++
            const alt = (textOf(child(node, 'svg:desc')) || textOf(child(node, 'svg:title')))
              .replace(/\s+/g, ' ')
              .trim()
            out += alt ? `[Image: ${alt}]` : '[Image]'
          }
          break
        }
        case 'draw:custom-shape':
          break
        default:
          out += this.inline(node)
      }
    }
    return out
  }

  private table(table: XmlElement): string[][] {
    return tableRows(table, (cell) => {
      const inner = new Writer()
      inner.blocks(cell)
      this.images += inner.images
      return inner.out
        .map((block) =>
          block.rows ? block.rows.map((row) => row.join(' ; ')).join(' / ') : block.text,
        )
        .join('\n')
    })
  }
}

/** A table's rows with repeated rows and cells expanded (within limits) and empty edges trimmed. */
export function tableRows(table: XmlElement, cellText: (cell: XmlElement) => string): string[][] {
  const rows: string[][] = []
  let cells = 0
  for (const row of elements(table, 'table:table-row')) {
    const values: string[] = []
    for (const cell of elements(row)) {
      if (cell.name !== 'table:table-cell' && cell.name !== 'table:covered-table-cell') continue
      const text = cell.name === 'table:covered-table-cell' ? '' : cellText(cell)
      const repeat = Math.min(
        MAX_REPEAT,
        Math.max(1, Number(cell.attrs['table:number-columns-repeated'] ?? 1) || 1),
      )
      for (let i = 0; i < repeat; i++) values.push(text)
    }
    while (values.length > 0 && values.at(-1) === '') values.pop()
    const repeat = Math.min(
      MAX_REPEAT,
      Math.max(1, Number(row.attrs['table:number-rows-repeated'] ?? 1) || 1),
    )
    for (let i = 0; i < repeat; i++) {
      if (cells + values.length > MAX_TABLE_CELLS) return trimRows(rows)
      cells += values.length
      rows.push(values)
    }
  }
  return trimRows(rows)
}

function trimRows(rows: string[][]): string[][] {
  while (rows.length > 1 && (rows.at(-1)?.length ?? 0) === 0) rows.pop()
  return rows
}

function readPage(page: XmlElement | undefined): {
  text: string
  title?: string
  images: number
  hidden?: boolean
} {
  if (!page) return { text: '', images: 0 }
  const lines: string[] = []
  let title: string | undefined
  let images = 0
  const shape = (node: XmlElement): void => {
    const writer = new Writer()
    if (node.name === 'draw:frame') {
      const image = child(node, 'draw:image')
      const table = child(node, 'table:table')
      if (table) {
        writer.blocks(node)
      } else if (image && !child(node, 'draw:text-box')) {
        images++
        const alt = (textOf(child(node, 'svg:desc')) || textOf(child(node, 'svg:title')))
          .replace(/\s+/g, ' ')
          .trim()
        lines.push(alt ? `[Image: ${alt}]` : '[Image]')
        return
      } else {
        for (const box of elements(node, 'draw:text-box')) writer.blocks(box)
      }
    } else {
      writer.blocks(node)
    }
    const text = writer.out.map((block) => block.text).join('\n')
    if (!text.trim()) return
    const kind = node.attrs['presentation:class']
    if (kind === 'title' && title === undefined) {
      title = text.replace(/\s+/g, ' ').trim()
      lines.push(`# ${title}`)
    } else {
      lines.push(text)
    }
  }
  for (const node of elements(page)) {
    if (node.name === 'draw:frame' || node.name === 'draw:custom-shape') shape(node)
  }
  const notes = child(page, 'presentation:notes')
  let said = ''
  for (const frame of elements(notes, 'draw:frame')) {
    if (frame.attrs['presentation:class'] !== 'notes') continue
    const writer = new Writer()
    for (const box of elements(frame, 'draw:text-box')) writer.blocks(box)
    said += writer.out.map((block) => block.text).join('\n')
  }
  let text = lines.join('\n')
  if (said.trim()) text += `${text ? '\n\n' : ''}Speaker notes:\n${said.trim()}`
  const name = page.attrs['draw:name']
  return {
    text,
    images,
    ...(title ? { title } : name && !/^page\d+$/i.test(name) ? { title: name } : {}),
    hidden: page.attrs['presentation:visibility'] === 'hidden',
  }
}
