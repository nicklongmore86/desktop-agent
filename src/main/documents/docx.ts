import type { DocumentLimits } from './limits'
import { coreProperties, type OfficePackage } from './package'
import { textView, type TextBlocks } from './text-view'
import { DocumentError, type DocumentView, type ExtractOptions } from './types'
import { child, elements, find, textOf, type XmlElement, type XmlNode } from './xml'

/**
 * Word (.docx): the body as Markdown-like text. Headings become `#` lines, list items
 * `-` or `1.` lines indented by level, tables Markdown tables; images become
 * `[Image: alt text]` and are counted, not rendered. Deleted text, field codes and the
 * fallback copies of alternate content are left out. Positions are characters of that
 * text, so a long document is read on with `start` whatever its pages or sections.
 */

const KEEP = new Set([
  'w:body',
  'w:p',
  'w:pPr',
  'w:pStyle',
  'w:numPr',
  'w:ilvl',
  'w:numId',
  'w:outlineLvl',
  'w:t',
  'w:tab',
  'w:br',
  'w:cr',
  'w:noBreakHyphen',
  'w:sym',
  'w:tbl',
  'w:tr',
  'w:tc',
  'w:tcPr',
  'w:gridSpan',
  'w:vMerge',
  'w:drawing',
  'w:pict',
  'w:object',
  'wp:docPr',
  'v:imagedata',
  'w:txbxContent',
])
/** Never read: formatting, deleted text, field codes, and the duplicate copy of alternate content. */
const SKIP = new Set([
  'w:rPr',
  'w:sectPr',
  'w:tblPr',
  'w:tblGrid',
  'w:trPr',
  'w:del',
  'w:delText',
  'w:instrText',
  'mc:Fallback',
  'w:footnoteReference',
  'w:commentReference',
])
const keep = (name: string): boolean | 'skip' => (SKIP.has(name) ? 'skip' : KEEP.has(name))

interface Style {
  heading?: number
  numId?: string
  ilvl?: number
  basedOn?: string
}

export async function extractDocx(
  pkg: OfficePackage,
  options: ExtractOptions,
  limits: DocumentLimits,
): Promise<DocumentView> {
  const document = await pkg.xml('word/document.xml', { keep, text: new Set(['w:t']) })
  const body = find(document ?? undefined, 'w:body')
  if (!body) throw new DocumentError('malformed', 'The Word document has no body.')
  const styles = await readStyles(pkg)
  const numbering = await readNumbering(pkg)
  const writer = new Writer(styles, numbering)
  writer.blocks(body.children)
  const view = textView('docx', writer.done(), options, limits)
  await coreProperties(pkg, view.meta)
  if (writer.images > 0) {
    view.warnings.push(
      `The document has ${String(writer.images)} image(s); they are not shown, only marked [Image] with any alt text.`,
    )
  }
  return view
}

async function readStyles(pkg: OfficePackage): Promise<Map<string, Style>> {
  const root = await pkg.xml('word/styles.xml', {
    keep: (name) =>
      [
        'w:styles',
        'w:style',
        'w:name',
        'w:basedOn',
        'w:pPr',
        'w:numPr',
        'w:numId',
        'w:ilvl',
        'w:outlineLvl',
      ].includes(name)
        ? true
        : name === 'w:rPr' || name === 'w:tblPr'
          ? 'skip'
          : false,
  })
  const styles = new Map<string, Style>()
  for (const style of elements(find(root ?? undefined, 'w:styles'), 'w:style')) {
    const id = style.attrs['w:styleId']
    if (!id) continue
    const entry: Style = {}
    const name = (child(style, 'w:name')?.attrs['w:val'] ?? '').toLowerCase()
    const heading = /^heading\s*([1-9])$/.exec(name)
    if (heading) entry.heading = Number(heading[1])
    else if (name === 'title') entry.heading = 1
    const pPr = child(style, 'w:pPr')
    const outline = outlineLevel(pPr)
    if (entry.heading === undefined && outline !== undefined) entry.heading = outline
    const numPr = child(pPr, 'w:numPr')
    const numId = child(numPr, 'w:numId')?.attrs['w:val']
    if (numId) entry.numId = numId
    const ilvl = Number(child(numPr, 'w:ilvl')?.attrs['w:val'])
    if (Number.isInteger(ilvl)) entry.ilvl = ilvl
    const basedOn = child(style, 'w:basedOn')?.attrs['w:val']
    if (basedOn) entry.basedOn = basedOn
    styles.set(id, entry)
  }
  return styles
}

/** numId -> level -> whether the list is numbered (anything but bullets). */
async function readNumbering(pkg: OfficePackage): Promise<Map<string, Map<number, boolean>>> {
  const root = await pkg.xml('word/numbering.xml', {
    keep: (name) =>
      ['w:numbering', 'w:abstractNum', 'w:lvl', 'w:numFmt', 'w:num', 'w:abstractNumId'].includes(
        name,
      )
        ? true
        : name === 'w:rPr' || name === 'w:pPr'
          ? 'skip'
          : false,
  })
  const numbering = find(root ?? undefined, 'w:numbering')
  const abstract = new Map<string, Map<number, boolean>>()
  for (const item of elements(numbering, 'w:abstractNum')) {
    const levels = new Map<number, boolean>()
    for (const lvl of elements(item, 'w:lvl')) {
      const format = child(lvl, 'w:numFmt')?.attrs['w:val'] ?? 'decimal'
      levels.set(Number(lvl.attrs['w:ilvl'] ?? 0), format !== 'bullet' && format !== 'none')
    }
    const id = item.attrs['w:abstractNumId']
    if (id !== undefined) abstract.set(id, levels)
  }
  const out = new Map<string, Map<number, boolean>>()
  for (const num of elements(numbering, 'w:num')) {
    const levels = abstract.get(child(num, 'w:abstractNumId')?.attrs['w:val'] ?? '')
    const id = num.attrs['w:numId']
    if (id !== undefined && levels) out.set(id, levels)
  }
  return out
}

function outlineLevel(pPr: XmlElement | undefined): number | undefined {
  const value = Number(child(pPr, 'w:outlineLvl')?.attrs['w:val'])
  return Number.isInteger(value) && value >= 0 && value < 9 ? value + 1 : undefined
}

class Writer {
  private readonly out: TextBlocks = []
  private readonly counters = new Map<string, number[]>()
  images = 0

  constructor(
    private readonly styles: Map<string, Style>,
    private readonly numbering: Map<string, Map<number, boolean>>,
  ) {}

  done(): TextBlocks {
    return this.out
  }

  blocks(nodes: XmlNode[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') continue
      if (node.name === 'w:p') this.paragraph(node)
      else if (node.name === 'w:tbl') {
        const rows = this.table(node)
        this.out.push({ text: markdownTable(rows), kind: 'table', rows })
      } else this.blocks(node.children)
    }
  }

  private style(id: string | undefined): Style {
    const merged: Style = {}
    for (let depth = 0; id && depth < 10; depth++) {
      const style = this.styles.get(id)
      if (!style) break
      if (merged.heading === undefined && style.heading !== undefined)
        merged.heading = style.heading
      if (merged.numId === undefined && style.numId !== undefined) merged.numId = style.numId
      if (merged.ilvl === undefined && style.ilvl !== undefined) merged.ilvl = style.ilvl
      id = style.basedOn
    }
    return merged
  }

  private paragraph(p: XmlElement): void {
    const nested: XmlElement[] = []
    const text = this.inline(p, nested).replace(/[ \t]+$/g, '')
    const pPr = child(p, 'w:pPr')
    const style = this.style(child(pPr, 'w:pStyle')?.attrs['w:val'])
    const numPr = child(pPr, 'w:numPr')
    const numId = child(numPr, 'w:numId')?.attrs['w:val'] ?? style.numId
    const ilvl = Math.min(8, Number(child(numPr, 'w:ilvl')?.attrs['w:val'] ?? style.ilvl ?? 0) || 0)
    const heading = outlineLevel(pPr) ?? style.heading
    if (text.trim()) {
      if (heading !== undefined) {
        this.out.push({ text: `${'#'.repeat(heading)} ${text.trim()}`, kind: 'heading' })
      } else if (numId && numId !== '0' && this.numbering.has(numId)) {
        const numbered = this.numbering.get(numId)?.get(ilvl) ?? false
        const marker = numbered ? `${String(this.count(numId, ilvl))}.` : '-'
        this.out.push({ text: `${'  '.repeat(ilvl)}${marker} ${text.trim()}`, kind: 'list' })
      } else {
        this.out.push({ text, kind: 'paragraph' })
      }
    }
    // Text boxes anchored in this paragraph follow it.
    for (const box of nested) this.blocks(box.children)
  }

  private count(numId: string, ilvl: number): number {
    const levels = this.counters.get(numId) ?? []
    levels[ilvl] = (levels[ilvl] ?? 0) + 1
    levels.length = ilvl + 1
    this.counters.set(numId, levels)
    return levels[ilvl] ?? 1
  }

  /** A paragraph's own text; text boxes inside it go to `nested`. */
  private inline(element: XmlElement, nested: XmlElement[]): string {
    let out = ''
    for (const node of element.children) {
      if (typeof node === 'string') continue
      switch (node.name) {
        case 'w:t':
          out += textOf(node)
          break
        case 'w:tab':
          out += '\t'
          break
        case 'w:br':
        case 'w:cr':
          out += '\n'
          break
        case 'w:noBreakHyphen':
          out += '-'
          break
        case 'w:pPr':
          break
        case 'w:txbxContent':
          nested.push(node)
          break
        case 'w:drawing':
        case 'w:pict':
        case 'w:object': {
          const alt = imageAlt(node)
          if (alt !== null) {
            this.images++
            out += alt ? `[Image: ${alt}]` : '[Image]'
          }
          out += this.inline(node, nested)
          break
        }
        default:
          out += this.inline(node, nested)
      }
    }
    return out
  }

  private table(tbl: XmlElement): string[][] {
    const rows: string[][] = []
    for (const tr of elements(tbl, 'w:tr')) {
      const cells: string[] = []
      for (const tc of elements(tr, 'w:tc')) {
        const tcPr = child(tc, 'w:tcPr')
        const merged = child(tcPr, 'w:vMerge')
        const continued = merged !== undefined && merged.attrs['w:val'] !== 'restart'
        cells.push(continued ? '' : this.cell(tc))
        const span = Number(child(tcPr, 'w:gridSpan')?.attrs['w:val'] ?? 1)
        for (let i = 1; i < Math.min(span, 64); i++) cells.push('')
      }
      rows.push(cells)
    }
    return rows
  }

  /** A cell's paragraphs on one line; a table inside it is flattened. */
  private cell(tc: XmlElement): string {
    const inner = new Writer(this.styles, this.numbering)
    inner.blocks(tc.children)
    this.images += inner.images
    return inner.out.map((block) => (block.rows ? flattenTable(block.rows) : block.text)).join('\n')
  }
}

/** A table inside a table cell, on one line: cells split by ';', rows by '/'. */
const flattenTable = (rows: string[][]): string =>
  rows.map((row) => row.map((cell) => cell.replace(/\n/g, ' ')).join(' ; ')).join(' / ')

/** '' for an image without alt text, null when the element holds no image at all. */
function imageAlt(element: XmlElement): string | null {
  const docPr = find(element, 'wp:docPr')
  if (docPr) return (docPr.attrs.descr ?? docPr.attrs.title ?? '').replace(/\s+/g, ' ').trim()
  if (find(element, 'v:imagedata')) return ''
  return null
}

/** Rows as a Markdown table, the first row as its header. Cells are kept to one line. */
export function markdownTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length))
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => escapeCell(cells[i] ?? '')).join(' | ')} |`
  const [head = [], ...rest] = rows
  return [line(head), `|${' --- |'.repeat(width)}`, ...rest.map(line)].join('\n')
}

export const escapeCell = (text: string): string =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .replace(/\t/g, ' ')
    .trim()
