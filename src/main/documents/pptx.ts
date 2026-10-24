import { markdownTable } from './docx'
import { effectiveBudget, type DocumentLimits } from './limits'
import { coreProperties, type OfficePackage } from './package'
import { MIME } from './sniff'
import {
  DocumentError,
  type DocumentKind,
  type DocumentSection,
  type DocumentView,
  type ExtractOptions,
} from './types'
import { child, elements, find, textOf, type XmlElement } from './xml'

/**
 * PowerPoint (.pptx): slide by slide, each slide's title, its text in shape order (tables
 * as Markdown, pictures as `[Image: alt text]`) and its speaker notes. Slides are the
 * position unit, as pages are for a PDF.
 */

const SLIDE_KEEP = new Set([
  'p:sld',
  'p:cSld',
  'p:spTree',
  'p:sp',
  'p:grpSp',
  'p:graphicFrame',
  'p:pic',
  'p:cNvPr',
  'p:ph',
  'p:txBody',
  'a:txBody',
  'a:p',
  'a:pPr',
  'a:t',
  'a:br',
  'a:tbl',
  'a:tr',
  'a:tc',
])
const SLIDE_SKIP = new Set([
  'a:rPr',
  'a:endParaRPr',
  'p:spPr',
  'a:bodyPr',
  'a:lstStyle',
  'mc:Fallback',
])
const slideKeep = (name: string): boolean | 'skip' =>
  SLIDE_SKIP.has(name) ? 'skip' : SLIDE_KEEP.has(name)
const TEXT = new Set(['a:t'])
const TITLES = new Set(['title', 'ctrTitle'])
/** Placeholders on a notes page that are not the notes: the slide image, number, header... */
const NOT_NOTES = new Set(['sldImg', 'sldNum', 'hdr', 'ftr', 'dt'])

export async function extractPptx(
  pkg: OfficePackage,
  options: ExtractOptions,
  limits: DocumentLimits,
): Promise<DocumentView> {
  const presentation = await pkg.xml('ppt/presentation.xml', {
    keep: (name) =>
      name === 'p:presentation' || name === 'p:sldIdLst' || name === 'p:sldId'
        ? true
        : name === 'p:defaultTextStyle' || name === 'p:extLst'
          ? 'skip'
          : false,
  })
  const list = find(presentation ?? undefined, 'p:sldIdLst')
  const rels = await pkg.relationships('ppt/presentation.xml')
  const slides = elements(list, 'p:sldId')
    .map((slide) => rels.get(slide.attrs['r:id'] ?? '')?.target)
    .filter((target): target is string => target !== undefined)

  const view = slideView('pptx', slides.length)
  await coreProperties(pkg, view.meta)
  await readSlides(view, options, limits, async (number) => {
    const part = slides[number - 1] ?? ''
    const slide = await pkg.xml(part, { keep: slideKeep, text: TEXT })
    if (!slide) return { text: '', images: 0 }
    const read = readShapes(find(slide, 'p:spTree'))
    const sld = find(slide, 'p:sld')
    let text = read.lines.join('\n')
    const notesPart = [...(await pkg.relationships(part)).values()].find((rel) =>
      rel.type.endsWith('/notesSlide'),
    )?.target
    if (notesPart) {
      const notes = await pkg.xml(notesPart, { keep: slideKeep, text: TEXT })
      const said = readShapes(find(notes ?? undefined, 'p:spTree'), true)
        .lines.join('\n')
        .trim()
      if (said) text += `${text ? '\n\n' : ''}Speaker notes:\n${said}`
    }
    return {
      text,
      images: read.images,
      ...(read.title ? { title: read.title } : {}),
      hidden: sld?.attrs.show === '0',
    }
  })
  return view
}

export interface SlideRead {
  text: string
  title?: string
  images: number
  hidden?: boolean
}

export function slideView(kind: DocumentKind, total: number): DocumentView {
  return {
    meta: { kind, mime: MIME[kind], pageCount: total },
    sections: [],
    images: [],
    position: { unit: 'slide', total, shown: { from: 0, to: 0 }, next: null },
    warnings: [],
  }
}

/** Reads slides `select.from`..`select.to`, at most maxPagesPerCall and within the text budget. */
export async function readSlides(
  view: DocumentView,
  options: ExtractOptions,
  limits: DocumentLimits,
  read: (number: number) => Promise<SlideRead>,
): Promise<void> {
  const total = view.position.total
  if (total === 0) {
    view.warnings.push('The presentation has no slides.')
    return
  }
  const from = Math.max(1, Math.floor(options.select?.from ?? 1))
  if (from > total) {
    throw new DocumentError(
      'out-of-range',
      `Slide ${String(from)} is past the end; the presentation has ${String(total)} slides.`,
    )
  }
  const { maxChars } = effectiveBudget(options.budget, limits)
  const to = Math.min(
    total,
    Math.max(from, Math.floor(options.select?.to ?? total)),
    from + limits.maxPagesPerCall - 1,
  )
  let chars = 0
  let last = from - 1
  let images = 0
  for (let number = from; number <= to; number++) {
    const slide = await read(number)
    let text = slide.text
    if (chars + text.length > maxChars) {
      if (number > from) break
      text = text.slice(0, maxChars)
      view.warnings.push(`Slide ${String(number)} was cut to ${String(maxChars)} characters.`)
    }
    chars += text.length
    images += slide.images
    const section: DocumentSection = { page: number, text }
    const title = [
      slide.title?.replace(/\s+/g, ' ').trim().slice(0, 150),
      slide.hidden ? '(hidden)' : '',
    ]
      .filter(Boolean)
      .join(' ')
    if (title) section.title = title
    view.sections.push(section)
    last = number
  }
  view.position.shown = { from, to: last }
  view.position.next = last < total ? last + 1 : null
  if (images > 0) {
    view.warnings.push(
      `The slides shown have ${String(images)} picture(s); they are not shown, only marked [Image] with any alt text.`,
    )
  }
}

/** The text of a slide's (or notes page's) shapes, in order, and the title placeholder's. */
function readShapes(
  tree: XmlElement | undefined,
  notes = false,
): { lines: string[]; title?: string; images: number } {
  const lines: string[] = []
  let title: string | undefined
  let images = 0
  const walk = (parent: XmlElement | undefined): void => {
    for (const shape of elements(parent)) {
      if (shape.name === 'p:grpSp') {
        walk(shape)
        continue
      }
      const placeholder = find(shape, 'p:ph')
      const type = placeholder?.attrs.type ?? (placeholder ? 'body' : undefined)
      if (notes && (type === undefined || NOT_NOTES.has(type))) continue
      if (shape.name === 'p:pic') {
        if (notes) continue
        images++
        const alt = (find(shape, 'p:cNvPr')?.attrs.descr ?? '').replace(/\s+/g, ' ').trim()
        lines.push(alt ? `[Image: ${alt}]` : '[Image]')
        continue
      }
      const table = find(shape, 'a:tbl')
      if (table) {
        lines.push(markdownTable(tableRows(table)))
        continue
      }
      const paragraphs = paragraphLines(child(shape, 'p:txBody'))
      if (paragraphs.length === 0) continue
      if (!notes && type && TITLES.has(type) && title === undefined) {
        title = paragraphs.map((line) => line.trim()).join(' ')
        lines.push(`# ${title}`)
      } else {
        lines.push(...paragraphs)
      }
    }
  }
  walk(tree)
  return { lines, ...(title ? { title } : {}), images }
}

function paragraphLines(body: XmlElement | undefined): string[] {
  const lines: string[] = []
  for (const p of elements(body, 'a:p')) {
    let text = ''
    for (const node of elements(p)) {
      if (node.name === 'a:t') text += textOf(node)
      else if (node.name === 'a:br') text += '\n'
    }
    if (!text.trim()) continue
    const level = Math.min(8, Number(child(p, 'a:pPr')?.attrs.lvl ?? 0) || 0)
    lines.push(`${'  '.repeat(level)}${text.trimEnd()}`)
  }
  return lines
}

function tableRows(table: XmlElement): string[][] {
  return elements(table, 'a:tr').map((tr) =>
    elements(tr, 'a:tc').map((tc) => paragraphLines(child(tc, 'a:txBody')).join('\n')),
  )
}
