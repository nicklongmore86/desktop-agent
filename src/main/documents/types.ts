/**
 * The document reader's contract, shared by the main process (worker-host.ts) and the
 * sandboxed worker page that does the parsing. Plain data only: everything here crosses
 * a MessagePort by structured clone.
 */

/** What the bytes are, decided by their magic numbers (sniff.ts), never by the file name. */
export type DocumentKind =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'ooxml'
  | 'odf'
  | 'zip'
  | 'ole'
  // What a view says it read: sniff.ts tells OLE files apart only by opening them.
  | 'doc'
  | 'xls'
  | 'ppt'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'csv'
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'bmp'
  | 'tiff'
  | 'avif'
  | 'heic'
  | 'rtf'
  | 'text'
  | 'unknown'

/** A part of a page to re-render larger, as fractions (0..1) of the page from its top left. */
export interface PageRegion {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface ExtractOptions {
  /** The caller's claimed MIME type. Detection ignores it; a mismatch adds a warning. */
  mime?: string
  /** The file name, for messages only. */
  name?: string
  /**
   * Which part to read: a 1-based inclusive range of pages, slides, characters or sheets
   * (whatever the view's `position.unit` is), or one region of one page. Spreadsheets also
   * take a sheet name and an A1 range (`Sheet1!A1:H200`, `A1:H200`, `A:C`, `5:20`).
   */
  select?: { from?: number; to?: number; region?: PageRegion; sheet?: string; range?: string }
  /** 'auto' renders pages with little or no text; 'images' renders every page shown; 'text' none. */
  view?: 'auto' | 'text' | 'images'
  budget?: {
    /** Text characters to return before stopping at a page boundary. */
    maxChars?: number
    /** Images (rendered pages or the decoded picture) to return. */
    maxImages?: number
    /** Long edge, in pixels, of every returned image. */
    longEdge?: number
  }
  /** Include GPS coordinates from EXIF. Off by default: location is personal data. */
  includeLocation?: boolean
  /** Spreadsheets: show each formula's text after its value. */
  includeFormulas?: boolean
}

export interface DocumentImage {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
  source: { page?: number; region?: PageRegion }
}

export interface DocumentSection {
  /** 1-based page (or slide) number, for paged documents. */
  page?: number
  title?: string
  text: string
  /** Spreadsheets: the sheet this section shows. */
  sheet?: SheetPart
}

/** One sheet of a workbook, as a section shows it. Ranges are A1 references without the sheet. */
export interface SheetPart {
  name: string
  /** The cells shown, or null when none are. */
  shown: string | null
  /** Where the sheet's cells are, or null when it is empty. */
  used: string | null
  /** The range to read next for more of this sheet. */
  next?: string
}

export interface SheetInfo {
  name: string
  used: string | null
  hidden?: boolean
}

export interface DocumentView {
  meta: {
    kind: DocumentKind
    mime: string
    name?: string
    pageCount?: number
    width?: number
    height?: number
    title?: string
    author?: string
    /** Workbooks: every sheet, in order (at most `office.maxSheets`). */
    sheets?: SheetInfo[]
  }
  sections: DocumentSection[]
  images: DocumentImage[]
  /**
   * Where this view sits in the whole: `shown` is inclusive, `next` is where to continue.
   * Slides count like pages (`meta.pageCount` is the slide count); `char` positions are in
   * the text the reader produced; a workbook moves sheet by sheet.
   */
  position: {
    unit: 'page' | 'slide' | 'char' | 'sheet' | 'image'
    total: number
    shown: { from: number; to: number }
    next: number | null
  }
  warnings: string[]
}

export type DocumentErrorCode =
  | 'too-large'
  | 'too-many-pixels'
  | 'password-protected'
  | 'malformed'
  | 'unsupported'
  | 'out-of-range'
  | 'zip-bomb'
  | 'timeout'
  | 'memory'
  | 'worker-failed'

/** A refusal with a stable code and a message that can be shown to the user or model. */
export class DocumentError extends Error {
  override readonly name = 'DocumentError'
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * What the app's callers (the read_document tool, attachments) need from the reader:
 * DocumentWorkerHost in the app, a fake in unit tests.
 */
export interface DocumentReader {
  extract(bytes: Uint8Array, options?: ExtractOptions): Promise<DocumentView>
}
