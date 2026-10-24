import * as XLSX from 'xlsx'
import { makeZip } from './fixtures.test-util'

/**
 * Small, real Office and OpenDocument files built in memory, so the tests carry no binary
 * fixtures. Workbooks (.xlsx, .xls, .ods) are written by SheetJS; Word, PowerPoint and
 * OpenDocument text and presentations are assembled from their XML parts as Word,
 * PowerPoint and LibreOffice lay them out; .doc and .ppt are OLE files with the streams
 * the readers look at.
 */

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const contentTypes = (overrides: [string, string][]): string =>
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  overrides
    .map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`)
    .join('') +
  '</Types>'

const relationships = (rels: [id: string, type: string, target: string][]): string =>
  `${XML}<Relationships xmlns="${NS.rel}">` +
  rels
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${NS.r}/${type}" Target="${target}"/>`,
    )
    .join('') +
  '</Relationships>'

const core = (title: string, author: string): string =>
  `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escape(title)}</dc:title>` +
  `<dc:creator>${escape(author)}</dc:creator></cp:coreProperties>`

// ---- Word ----

/** A paragraph: plain, a heading style, or a list item (numId 1 is bullets, 2 is numbers). */
export function wp(
  text: string,
  { style, list, level = 0 }: { style?: string; list?: 1 | 2; level?: number } = {},
): string {
  const pPr =
    style || list
      ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${
          list
            ? `<w:numPr><w:ilvl w:val="${String(level)}"/><w:numId w:val="${String(list)}"/></w:numPr>`
            : ''
        }</w:pPr>`
      : ''
  return `<w:p>${pPr}<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`
}

/** A table: each cell is text, or raw XML for a nested table. */
export function wtbl(rows: (string | { xml: string })[][]): string {
  const cell = (value: string | { xml: string }): string =>
    `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${
      typeof value === 'string' ? wp(value) : `${value.xml}<w:p/>`
    }</w:tc>`
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>${rows
    .map((row) => `<w:tr>${row.map(cell).join('')}</w:tr>`)
    .join('')}</w:tbl>`
}

/** An inline picture with alt text, as Word writes one (with its mc:Fallback copy). */
export const wimage = (alt: string): string =>
  '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline>' +
  `<wp:docPr id="1" name="Picture 1" descr="${escape(alt)}"/>` +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"/></a:graphic>' +
  '</wp:inline></w:drawing></mc:Choice><mc:Fallback><w:pict><w:t>fallback copy</w:t></w:pict></mc:Fallback>' +
  '</mc:AlternateContent></w:r></w:p>'

const STYLES =
  `${XML}<w:styles xmlns:w="${NS.w}">` +
  '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/>' +
  '<w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
  // A localised heading name: only its outline level says it is one.
  '<w:style w:type="paragraph" w:styleId="berschrift3"><w:name w:val="Überschrift 3"/>' +
  '<w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/>' +
  '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>' +
  '</w:styles>'

const NUMBERING =
  `${XML}<w:numbering xmlns:w="${NS.w}">` +
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>' +
  '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>' +
  '<w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
  '</w:numbering>'

/** A .docx whose body is `body` (paragraphs and tables from wp/wtbl), or a whole document.xml. */
export function makeDocx(
  body: string,
  {
    document,
    title = 'Plan',
    author = 'Ada',
  }: { document?: string; title?: string; author?: string } = {},
): Uint8Array {
  const main =
    document ??
    `${XML}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" ` +
      `xmlns:mc="${NS.mc}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: contentTypes([
        [
          'word/document.xml',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        ],
      ]),
    },
    { name: '_rels/.rels', data: relationships([['rId1', 'officeDocument', 'word/document.xml']]) },
    { name: 'word/document.xml', data: main },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'docProps/core.xml', data: core(title, author) },
  ])
}

// ---- PowerPoint ----

export interface FixtureSlide {
  title?: string
  body?: string[]
  notes?: string
  table?: string[][]
  image?: string
  hidden?: boolean
}

const shape = (placeholder: string, paragraphs: string[]): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>` +
  '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' +
  paragraphs
    .map((text) => {
      const level = /^ +/.exec(text)?.[0].length ?? 0
      return `<a:p>${level ? `<a:pPr lvl="${String(level)}"/>` : ''}<a:r><a:rPr lang="en-GB"/><a:t>${escape(text.trimStart())}</a:t></a:r></a:p>`
    })
    .join('') +
  '</p:txBody></p:sp>'

function slideXml(slide: FixtureSlide): string {
  let tree = ''
  if (slide.title !== undefined) tree += shape('<p:ph type="title"/>', [slide.title])
  if (slide.body) tree += shape('<p:ph idx="1"/>', slide.body)
  if (slide.table) {
    tree +=
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
      slide.table
        .map(
          (row) =>
            `<a:tr h="370840">${row
              .map(
                (cell) =>
                  `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${escape(cell)}</a:t></a:r></a:p></a:txBody></a:tc>`,
              )
              .join('')}</a:tr>`,
        )
        .join('') +
      '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  }
  if (slide.image !== undefined) {
    tree += `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture" descr="${escape(slide.image)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`
  }
  return (
    `${XML}<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"${slide.hidden ? ' show="0"' : ''}>` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${tree}</p:spTree></p:cSld></p:sld>`
  )
}

const notesXml = (text: string): string =>
  `${XML}<p:notes xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:spTree>` +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
  shape('<p:ph type="sldImg"/>', []) +
  shape('<p:ph type="body" idx="1"/>', text.split('\n')) +
  shape('<p:ph type="sldNum" idx="5"/>', ['7']) +
  '</p:spTree></p:cSld></p:notes>'

export function makePptx(
  slides: FixtureSlide[],
  { title = 'Deck', author = 'Ada' } = {},
): Uint8Array {
  const entries: { name: string; data: string }[] = [
    {
      name: '[Content_Types].xml',
      data: contentTypes([
        [
          'ppt/presentation.xml',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
        ],
      ]),
    },
    {
      name: '_rels/.rels',
      data: relationships([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    },
    {
      name: 'ppt/presentation.xml',
      // Slide order is the list's, not the part names': slide 2's part comes first here.
      data:
        `${XML}<p:presentation xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:sldIdLst>` +
        slides
          .map((_, i) => `<p:sldId id="${String(256 + i)}" r:id="rId${String(i + 10)}"/>`)
          .join('') +
        '</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: relationships(
        slides.map((_, i) => [`rId${String(i + 10)}`, 'slide', `slides/slide${String(i + 1)}.xml`]),
      ),
    },
    { name: 'docProps/core.xml', data: core(title, author) },
  ]
  slides.forEach((slide, i) => {
    const n = String(i + 1)
    entries.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml(slide) })
    if (slide.notes !== undefined) {
      entries.push(
        {
          name: `ppt/slides/_rels/slide${n}.xml.rels`,
          data: relationships([['rId1', 'notesSlide', `../notesSlides/notesSlide${n}.xml`]]),
        },
        { name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesXml(slide.notes) },
      )
    }
  })
  return makeZip(entries)
}

// ---- Workbooks (written by SheetJS) ----

export type FixtureCell = string | number | boolean | { f: string; v?: number }
export type FixtureSheets = Record<string, FixtureCell[][]>

function workbook(sheets: FixtureSheets, hidden: string[] = []): XLSX.WorkBook {
  const book = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    const data = rows.map((row) =>
      row.map((cell) =>
        typeof cell === 'object'
          ? { t: 'n', f: cell.f, ...(cell.v === undefined ? {} : { v: cell.v }) }
          : cell,
      ),
    )
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), name)
  }
  book.Workbook = {
    Sheets: book.SheetNames.map((name) => ({ name, Hidden: hidden.includes(name) ? 1 : 0 })),
  }
  return book
}

export function makeWorkbook(
  sheets: FixtureSheets,
  type: 'xlsx' | 'xlsm' | 'biff8' | 'ods' = 'xlsx',
  hidden: string[] = [],
): Uint8Array {
  return new Uint8Array(
    XLSX.write(workbook(sheets, hidden), {
      type: 'array',
      bookType: type,
      compression: true,
      // Strings in a shared table, as Excel writes them.
      bookSST: true,
    }) as ArrayBuffer,
  )
}

/** Rows numbered from 1: `row(n)` gives one row of `columns` cells naming their address. */
export function grid(rows: number, columns: number, start = 0): FixtureCell[][] {
  return Array.from({ length: rows }, (_, r) =>
    Array.from(
      { length: columns },
      (_, c) => `${XLSX.utils.encode_col(c)}${String(r + 1 + start)}`,
    ),
  )
}

// ---- OpenDocument ----

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"'

function makeOdf(mime: string, body: string, title: string): Uint8Array {
  return makeZip([
    { name: 'mimetype', data: mime, stored: true },
    {
      name: 'content.xml',
      data: `${XML}<office:document-content ${ODF_NS} office:version="1.3"><office:automatic-styles><style:style xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" style:name="P1"/></office:automatic-styles><office:body>${body}</office:body></office:document-content>`,
    },
    {
      name: 'meta.xml',
      data: `${XML}<office:document-meta ${ODF_NS}><office:meta><dc:title>${escape(title)}</dc:title><meta:initial-creator>Ada</meta:initial-creator></office:meta></office:document-meta>`,
    },
    {
      name: 'META-INF/manifest.xml',
      data: `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/></manifest:manifest>`,
    },
  ])
}

export const makeOdt = (text: string, title = 'Notes'): Uint8Array =>
  makeOdf('application/vnd.oasis.opendocument.text', `<office:text>${text}</office:text>`, title)

export const makeOdp = (pages: string, title = 'Talk'): Uint8Array =>
  makeOdf(
    'application/vnd.oasis.opendocument.presentation',
    `<office:presentation>${pages}</office:presentation>`,
    title,
  )

// ---- OLE: Word 97-2003, PowerPoint 97-2003, encrypted packages ----

/** SheetJS's CFB writer, untyped upstream. */
const CFB = XLSX.CFB as {
  write: (container: unknown, options: { type: 'array' }) => ArrayLike<number>
  utils: {
    cfb_new: () => unknown
    cfb_add: (container: unknown, name: string, content: Uint8Array) => void
  }
}

function ole(streams: Record<string, Uint8Array>): Uint8Array {
  const cfb = CFB.utils.cfb_new()
  for (const [name, data] of Object.entries(streams)) CFB.utils.cfb_add(cfb, `/${name}`, data)
  return new Uint8Array(CFB.write(cfb, { type: 'array' }))
}

/**
 * A Word 97 document: a FIB pointing at a piece table with two pieces, the first stored
 * as 8-bit (CP-1252) text and the second as UTF-16, as Word does after an edit.
 */
export function makeDoc(
  first: string,
  second: string,
  { encrypted = false, nFib = 0x00c1 }: { encrypted?: boolean; nFib?: number } = {},
): Uint8Array {
  const textAt = 0x800
  const firstBytes = Uint8Array.from(first, (char) => (char === '€' ? 0x80 : char.charCodeAt(0)))
  const secondAt = textAt + firstBytes.length + (firstBytes.length % 2)
  const main = new Uint8Array(secondAt + second.length * 2 + 16)
  const view = new DataView(main.buffer)
  view.setUint16(0, 0xa5ec, true)
  view.setUint16(2, nFib, true)
  view.setUint16(0x0a, 0x0200 | (encrypted ? 0x0100 : 0), true)
  view.setUint16(32, 14, true)
  view.setUint16(62, 22, true)
  view.setInt32(0x4c, first.length + second.length, true)
  view.setUint16(152, 0x5d, true)
  main.set(firstBytes, textAt)
  for (let i = 0; i < second.length; i++)
    view.setUint16(secondAt + i * 2, second.charCodeAt(i), true)

  // CLX: one Pcdt holding CPs [0, first, first + second] and two piece descriptors.
  const clx = new Uint8Array(5 + 3 * 4 + 2 * 8)
  const cv = new DataView(clx.buffer)
  clx[0] = 0x02
  cv.setUint32(1, clx.length - 5, true)
  cv.setUint32(5, 0, true)
  cv.setUint32(9, first.length, true)
  cv.setUint32(13, first.length + second.length, true)
  cv.setUint32(17 + 2, ((textAt * 2) | 0x40000000) >>> 0, true)
  cv.setUint32(25 + 2, secondAt, true)
  const table = new Uint8Array(0x40 + clx.length)
  table.set(clx, 0x40)
  view.setUint32(0x1a2, 0x40, true)
  view.setUint32(0x1a6, clx.length, true)
  return ole({ WordDocument: main, '1Table': table })
}

export const makePpt = (): Uint8Array =>
  ole({ 'PowerPoint Document': new Uint8Array(64), 'Current User': new Uint8Array(32) })

export const makeEncryptedPackage = (): Uint8Array =>
  ole({ EncryptionInfo: new Uint8Array(64), EncryptedPackage: new Uint8Array(512) })

// ---- Hostile OLE files: valid ones from SheetJS's writer, with one structure broken ----

const u32 = (bytes: Uint8Array, at: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true)
const setU32 = (bytes: Uint8Array, at: number, value: number): void => {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(at, value >>> 0, true)
}
const sectorAt = (n: number): number => (n + 1) * 512
/** The FAT entry for sector n (the writer's files are small: one FAT sector). */
const fatAt = (bytes: Uint8Array, n: number): number => sectorAt(u32(bytes, 0x4c)) + n * 4

/** The byte offset of the directory entry named `name`, following the directory's chain. */
function entryAt(bytes: Uint8Array, name: string): number {
  for (
    let sector = u32(bytes, 0x30);
    sector !== 0xfffffffe;
    sector = u32(bytes, fatAt(bytes, sector))
  ) {
    for (let i = 0; i < 4; i++) {
      const at = sectorAt(sector) + i * 128
      const length = new DataView(bytes.buffer, bytes.byteOffset).getUint16(at + 0x40, true)
      const found = new TextDecoder('utf-16le').decode(
        bytes.subarray(at, at + Math.max(0, length - 2)),
      )
      if (found === name) return at
    }
  }
  throw new Error(`no entry ${name}`)
}

/** A file padded with zeroed sectors to `sectors` sectors after the header. */
function padded(bytes: Uint8Array, sectors: number): Uint8Array {
  const out = new Uint8Array(sectorAt(sectors))
  out.set(bytes)
  return out
}

/** A Word-like OLE file whose main stream is big enough to live in the FAT. */
const baseOle = (): Uint8Array =>
  ole({ WordDocument: new Uint8Array(8192).fill(7), '1Table': new Uint8Array(64) })

export const hostileOle = {
  /** A stream's chain points back at its own first sector. */
  fatLoop(): Uint8Array {
    const bytes = baseOle()
    const start = u32(bytes, entryAt(bytes, 'WordDocument') + 0x74)
    setU32(bytes, fatAt(bytes, start), start)
    return bytes
  },
  /** The header says the FAT needs two DIFAT sectors; the first names itself as the next. */
  difatLoop(): Uint8Array {
    const base = baseOle()
    const used = Math.ceil(base.length / 512) - 1
    const bytes = padded(base, 320)
    setU32(bytes, 0x2c, 300)
    setU32(bytes, 0x44, used)
    setU32(bytes, 0x48, 2)
    setU32(bytes, sectorAt(used) + 508, used)
    return bytes
  },
  /** A stream declaring 2 GB in a file of a few kilobytes. */
  hugeStream(): Uint8Array {
    const bytes = baseOle()
    setU32(bytes, entryAt(bytes, 'WordDocument') + 0x78, 0x7fffffff)
    return bytes
  },
  /** A directory entry that is its own left sibling. */
  directoryCycle(): Uint8Array {
    const bytes = baseOle()
    const child = u32(bytes, entryAt(bytes, 'Root Entry') + 0x4c)
    setU32(bytes, sectorAt(u32(bytes, 0x30)) + child * 128 + 0x44, child)
    return bytes
  },
  /** Cut off after the header and its first sector. */
  truncated(): Uint8Array {
    return baseOle().slice(0, 1024)
  },
  /**
   * Unused sectors chained backwards (each to the one before), which a reader that walks
   * every chain from every sector re-walks again and again: quadratic time and memory.
   */
  tangledFat(): Uint8Array {
    const base = baseOle()
    const used = Math.ceil(base.length / 512) - 1
    const bytes = padded(base, 128)
    setU32(bytes, fatAt(bytes, used), 0xfffffffe)
    for (let n = used + 1; n < 128; n++) setU32(bytes, fatAt(bytes, n), n - 1)
    return bytes
  },
}
