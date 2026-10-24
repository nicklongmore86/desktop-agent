import type { DocumentLimits } from './limits'
import { CFB, extractXls, type CfbContainer } from './sheets'
import { textView } from './text-view'
import { DocumentError, type DocumentView, type ExtractOptions } from './types'

/**
 * Legacy Office files (OLE compound files), opened with SheetJS's CFB reader to see what
 * they hold: Excel 97-2003 workbooks are read with SheetJS; Word 97-2003 documents get a
 * best-effort text extraction from the piece table (below); PowerPoint 97-2003 and
 * anything else is refused with what to do instead. A password-protected .docx, .xlsx or
 * .pptx is an OLE file too (an encrypted package), and is reported as such.
 */

type CfbEntry = CfbContainer['FileIndex'][number]

export function extractOle(
  bytes: Uint8Array,
  options: ExtractOptions,
  limits: DocumentLimits,
): DocumentView {
  let cfb: CfbContainer
  try {
    cfb = CFB.read(bytes, { type: 'array' })
  } catch {
    throw new DocumentError('malformed', 'The legacy Office file is damaged.')
  }
  const streams = new Map<string, CfbEntry>()
  for (const entry of cfb.FileIndex) {
    // Top-level streams only (type 2); their names are what tell the formats apart.
    if (entry.type === 2 && !streams.has(entry.name)) streams.set(entry.name, entry)
  }
  if (streams.has('EncryptedPackage') || streams.has('EncryptionInfo')) {
    throw new DocumentError(
      'password-protected',
      'The Office document is password-protected. Save a copy without the password and try again.',
    )
  }
  if (streams.has('Workbook') || streams.has('Book')) {
    return extractXls(bytes, options, limits)
  }
  const word = streams.get('WordDocument')
  if (word) return extractDoc(word, streams, options, limits)
  if (streams.has('PowerPoint Document')) {
    throw new DocumentError(
      'unsupported',
      'Older PowerPoint (.ppt) files cannot be read. Open it in PowerPoint and save it as .pptx, then try again.',
    )
  }
  if ([...streams.keys()].some((name) => name.startsWith('__substg1.0_'))) {
    throw new DocumentError('unsupported', 'Outlook messages (.msg) cannot be read here.')
  }
  throw new DocumentError(
    'unsupported',
    'This legacy Office file is not a document that can be read.',
  )
}

const SAVE_AS_DOCX = 'Open it in Word and save it as .docx, then try again.'

/**
 * Word 97-2003 text, best effort: the main document's characters from the piece table
 * (the CLX in the table stream), with field codes dropped and their results kept. No
 * formatting, headings or table structure: table cells come out tab-separated, one row
 * per line.
 */
function extractDoc(
  word: CfbEntry,
  streams: Map<string, CfbEntry>,
  options: ExtractOptions,
  limits: DocumentLimits,
): DocumentView {
  const main = bytesOf(word)
  const fail = (why: string): DocumentError =>
    new DocumentError(
      'unsupported',
      `This Word 97-2003 document could not be read (${why}). ${SAVE_AS_DOCX}`,
    )
  if (main.length < 0x1aa) throw fail('it is too short')
  const view = new DataView(main.buffer, main.byteOffset, main.byteLength)
  if (view.getUint16(0, true) !== 0xa5ec) throw fail('it has no Word header')
  const nFib = view.getUint16(2, true)
  if (nFib < 0x00c1) throw fail('it was saved by Word 95 or older')
  const flags = view.getUint16(0x0a, true)
  if (flags & 0x0100) {
    throw new DocumentError(
      'password-protected',
      'The Word document is password-protected. Save a copy without the password and try again.',
    )
  }
  const table = streams.get(flags & 0x0200 ? '1Table' : '0Table')
  if (!table) throw fail('its table stream is missing')
  const tableBytes = bytesOf(table)
  const ccpText = view.getInt32(0x4c, true)
  const fcClx = view.getUint32(0x1a2, true)
  const lcbClx = view.getUint32(0x1a6, true)
  if (ccpText < 0 || fcClx + lcbClx > tableBytes.length || lcbClx === 0) {
    throw fail('its text table is damaged')
  }
  const raw = pieceText(main, tableBytes.subarray(fcClx, fcClx + lcbClx), ccpText, fail)
  const out = textView('doc', cleanDocText(raw), options, limits)
  out.warnings.push(
    'This is a Word 97-2003 document: its text was read without headings, lists or table layout. Save it as .docx for a fuller reading.',
  )
  return out
}

function bytesOf(entry: CfbEntry): Uint8Array {
  const content = entry.content ?? []
  return content instanceof Uint8Array ? content : Uint8Array.from(content)
}

/** The first `ccpText` characters of the document, through the piece table in `clx`. */
function pieceText(
  main: Uint8Array,
  clx: Uint8Array,
  ccpText: number,
  fail: (why: string) => DocumentError,
): string {
  const view = new DataView(clx.buffer, clx.byteOffset, clx.byteLength)
  let at = 0
  // Skip the property modifiers (Prc, 0x01) before the piece table (Pcdt, 0x02).
  while (at < clx.length && clx[at] === 0x01) {
    if (at + 3 > clx.length) throw fail('its text table is damaged')
    at += 3 + view.getUint16(at + 1, true)
  }
  if (clx[at] !== 0x02 || at + 5 > clx.length) throw fail('its text table is damaged')
  const length = view.getUint32(at + 1, true)
  const start = at + 5
  if (start + length > clx.length || length < 4 || (length - 4) % 12 !== 0) {
    throw fail('its text table is damaged')
  }
  const pieces = (length - 4) / 12
  const cp = (i: number): number => view.getUint32(start + i * 4, true)
  const windows1252 = new TextDecoder('windows-1252')
  const utf16 = new TextDecoder('utf-16le')
  let text = ''
  for (let i = 0; i < pieces && text.length < ccpText; i++) {
    const from = cp(i)
    const to = Math.min(cp(i + 1), ccpText)
    if (to <= from) continue
    const pcd = start + (pieces + 1) * 4 + i * 8
    const fc = view.getUint32(pcd + 2, true)
    const compressed = (fc & 0x40000000) !== 0
    const count = to - from
    if (compressed) {
      const offset = (fc & 0x3fffffff) / 2
      if (offset + count > main.length) throw fail('a piece of its text is missing')
      text += windows1252.decode(main.subarray(offset, offset + count))
    } else {
      if (fc + count * 2 > main.length) throw fail('a piece of its text is missing')
      text += utf16.decode(main.subarray(fc, fc + count * 2))
    }
  }
  return text
}

/**
 * Word's control characters as text: paragraph marks become line breaks, cell marks tabs,
 * field instructions (between 0x13 and 0x14) are dropped and their results kept.
 */
export function cleanDocText(raw: string): string {
  let out = ''
  // For each open field: whether its instruction part is still running.
  const fields: boolean[] = []
  // How many of them are, so a hostile file's deep nesting costs nothing per character.
  let instructions = 0
  for (const char of raw) {
    const code = char.charCodeAt(0)
    if (code === 0x13) {
      fields.push(true)
      instructions++
      continue
    }
    if (code === 0x14) {
      if (fields.at(-1) === true) {
        fields[fields.length - 1] = false
        instructions--
      }
      continue
    }
    if (code === 0x15) {
      if (fields.pop() === true) instructions--
      continue
    }
    if (instructions > 0) continue
    switch (code) {
      case 0x0d:
      case 0x0b:
      case 0x0c:
        out += '\n'
        break
      case 0x07:
      case 0x09:
        out += '\t'
        break
      case 0x1e:
        out += '-'
        break
      default:
        if (code >= 0x20 || code === 0x0a) out += char
    }
  }
  return out
    .replace(/\t\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
