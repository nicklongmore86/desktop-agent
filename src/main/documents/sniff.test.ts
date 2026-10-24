import { describe, expect, it } from 'vitest'
import { jpegShell, makePdf, makeZip, pngShell } from './fixtures.test-util'
import { sniff } from './sniff'

const bytes = (...values: (number | string)[]): Uint8Array =>
  new Uint8Array(
    values.flatMap((value) =>
      typeof value === 'string' ? Array.from(value, (c) => c.charCodeAt(0)) : [value],
    ),
  )
const ftyp = (major: string, ...compatible: string[]): Uint8Array => {
  const size = 16 + compatible.length * 4
  return bytes(0, 0, 0, size, 'ftyp', major, 0, 0, 0, 0, ...compatible)
}

describe('sniff', () => {
  it.each([
    ['pdf', makePdf([{ text: ['hi'] }])],
    ['pdf', bytes('junk before the header\n%PDF-1.7\n')],
    ['ole', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0)],
    ['jpeg', jpegShell(10, 10)],
    ['png', pngShell(10, 10)],
    ['gif', bytes('GIF89a', 1, 0, 1, 0)],
    ['gif', bytes('GIF87a', 1, 0, 1, 0)],
    ['webp', bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')],
    ['bmp', bytes('BM', ...new Array<number>(12).fill(0), 40, 0, 0, 0)],
    ['tiff', bytes('II', 42, 0, 8, 0, 0, 0)],
    ['tiff', bytes('MM', 0, 42, 0, 0, 0, 8)],
    ['heic', ftyp('heic', 'mif1', 'heic')],
    ['heic', ftyp('mif1', 'heix')],
    ['avif', ftyp('avif', 'mif1', 'avif')],
    ['rtf', bytes('{\\rtf1\\ansi hello}')],
    ['text', new TextEncoder().encode('plain words, café\n')],
    ['text', bytes(0xff, 0xfe, 'h', 0, 'i', 0)],
    ['unknown', bytes(0x00, 0x01, 0x02, 0x03, 0xff, 0x00)],
    ['unknown', bytes('BM', 1, 2, 3)],
  ])('detects %s', (kind, input) => {
    expect(sniff(input).kind).toBe(kind)
  })

  it('tells the Office Open XML formats apart by their parts', () => {
    const ooxml = (part: string) =>
      makeZip([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: part, data: '<x/>' },
      ])
    expect(sniff(ooxml('word/document.xml'))).toMatchObject({
      kind: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    expect(sniff(ooxml('xl/workbook.xml')).kind).toBe('xlsx')
    expect(sniff(ooxml('ppt/presentation.xml')).kind).toBe('pptx')
    expect(sniff(ooxml('custom/part.xml')).kind).toBe('ooxml')
    expect(sniff(makeZip([{ name: 'word/document.xml', data: '<x/>' }])).kind).toBe('zip')
  })

  it('reads the ODF mimetype entry', () => {
    const odt = makeZip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', stored: true },
      { name: 'content.xml', data: '<x/>' },
    ])
    expect(sniff(odt)).toEqual({ kind: 'odt', mime: 'application/vnd.oasis.opendocument.text' })
    const odg = makeZip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.graphics', stored: true },
      { name: 'content.xml', data: '<x/>' },
    ])
    expect(sniff(odg)).toEqual({ kind: 'odf', mime: 'application/vnd.oasis.opendocument.graphics' })
  })

  it('ignores the name: a PDF renamed .jpg is still a PDF', () => {
    // There is no name parameter at all; only the bytes count.
    expect(sniff(makePdf([{}])).kind).toBe('pdf')
  })

  it('does not throw on truncated or empty input', () => {
    expect(sniff(new Uint8Array()).kind).toBe('text')
    expect(sniff(bytes('PK', 3, 4)).kind).toBe('zip')
    expect(sniff(bytes(0, 0, 0, 0xff, 'ftyp')).kind).toBe('unknown')
  })
})
