import { describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS } from '../../shared/attachments'
import { classifyAttachment } from './classify'
import { imageSize, MAX_IMAGE_PIXELS, prepareImage, type ImageScaler } from './image'
import { pdfPageCount } from './pdf'
import { docx, MSI_CLSID, oleFile, pngHeader, WORD_CLSID, zipEntries } from './test-support'

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ])
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

describe('classifyAttachment', () => {
  it.each([
    ['PNG', pngHeader(10, 10), 'image', 'image/png'],
    ['JPEG', jpegHeader(10, 10), 'image', 'image/jpeg'],
    ['GIF', Buffer.from('GIF89a\x0a\x00\x0a\x00', 'latin1'), 'image', 'image/gif'],
    ['WebP', Buffer.from('RIFF\0\0\0\0WEBPVP8X', 'latin1'), 'image', 'image/webp'],
    ['PDF', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), 'pdf', 'application/pdf'],
    ['UTF-8 text', Buffer.from('# Notes\nhéllo ✓\n'), 'text', 'text/plain'],
    ['UTF-16 text with BOM', Buffer.from('﻿hi there', 'utf16le'), 'text', 'text/plain'],
    ['empty file', Buffer.alloc(0), 'text', 'text/plain'],
  ])('%s', (_name, bytes, kind, mime) => {
    expect(classifyAttachment(bytes)).toEqual({ ok: true, kind, mime })
  })

  it.each([
    ['a bare zip header', Buffer.from('PK\x03\x04\x14\x00\x00\x00\x08\x00', 'latin1')],
    ['Windows executable', Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00', 'latin1')],
    ['ELF binary', Buffer.from('\x7fELF\x02\x01\x01\x00\x00\x00', 'latin1')],
    ['control characters', Buffer.from('\x01\x02\x03\x04\x05abc\x06\x07', 'latin1')],
  ])('refuses %s as binary, like read_file', (_name, bytes) => {
    expect(classifyAttachment(bytes)).toEqual({ ok: false, code: 'binary' })
  })

  it('ignores names and claimed types: only the bytes decide', () => {
    // A PNG signature in a .txt is an image; text in a .png is text.
    expect(classifyAttachment(pngHeader(1, 1))).toMatchObject({ kind: 'image' })
    expect(classifyAttachment(Buffer.from('not really a png'))).toMatchObject({ kind: 'text' })
  })
})

describe('classifyAttachment: documents', () => {
  const OOXML = 'application/vnd.openxmlformats-officedocument'
  it.each([
    ['docx', docx(), `${OOXML}.wordprocessingml.document`],
    [
      'xlsx',
      zipEntries([
        ['[Content_Types].xml', '<Types/>'],
        ['xl/workbook.xml', '<w/>'],
      ]),
      `${OOXML}.spreadsheetml.sheet`,
    ],
    [
      'pptx',
      zipEntries([
        ['[Content_Types].xml', '<Types/>'],
        ['_rels/.rels', '<r/>'],
        ['ppt/p.xml', '<p/>'],
      ]),
      `${OOXML}.presentationml.presentation`,
    ],
    [
      'odt',
      zipEntries([
        ['mimetype', 'application/vnd.oasis.opendocument.text'],
        ['content.xml', '<c/>'],
      ]),
      'application/vnd.oasis.opendocument.text',
    ],
    ['doc (class id)', oleFile({ classId: WORD_CLSID }), 'application/msword'],
    ['xls (stream name)', oleFile({ streams: ['Workbook'] }), 'application/vnd.ms-excel'],
    [
      'ppt (stream name)',
      oleFile({ streams: ['PowerPoint Document'] }),
      'application/vnd.ms-powerpoint',
    ],
    ['msg', oleFile({ streams: ['__substg1.0_0037001F'] }), 'application/vnd.ms-outlook'],
    ['rtf', Buffer.from('{\\rtf1\\ansi Hello}'), 'application/rtf'],
    [
      'eml',
      Buffer.from('Received: by mx\r\nFrom: a@example.com\r\nSubject: Hi\r\n\r\nBody\r\n'),
      'message/rfc822',
    ],
    ['TIFF', Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]), 'image/tiff'],
    [
      'BMP',
      Buffer.concat([Buffer.from('BM'), Buffer.alloc(12), Buffer.from([40, 0, 0, 0])]),
      'image/bmp',
    ],
    ['HEIC', Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'), 'image/heic'],
    ['AVIF', Buffer.from('\0\0\0\x1cftypavif\0\0\0\0avifmif1', 'latin1'), 'image/avif'],
  ])('%s is a document', (_name, bytes, mime) => {
    expect(classifyAttachment(bytes)).toEqual({ ok: true, kind: 'document', mime })
  })

  it.each([
    ['an .msi installer', oleFile({ classId: MSI_CLSID })],
    ['an unknown compound file', oleFile({ streams: ['Thumbs'] })],
    ['a jar', zipEntries([['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0']])],
    ['an epub', zipEntries([['mimetype', 'application/epub+zip']])],
    [
      'a .vsix/.nupkg package (given its first MB)',
      zipEntries([
        ['[Content_Types].xml', '<T/>'],
        ['extension/a.js', Buffer.alloc(1024 * 1024, 1)],
      ]),
    ],
    ['an MP4 video', Buffer.from('\0\0\0\x18ftypisom\0\0\x02\0isomiso2', 'latin1')],
  ])('refuses %s', (_name, bytes) => {
    expect(classifyAttachment(bytes)).toEqual({ ok: false, code: 'binary' })
  })

  it('asks for more bytes when a container is not decided by its start', () => {
    const late = docx(20_000)
    expect(classifyAttachment(late.subarray(0, 8000))).toEqual({
      ok: false,
      code: 'need-more',
      bytes: 1024 * 1024,
    })
    expect(classifyAttachment(late)).toMatchObject({ ok: true, kind: 'document' })
    const ole = oleFile({ classId: WORD_CLSID, directorySector: 20 })
    expect(classifyAttachment(ole.subarray(0, 8000))).toEqual({
      ok: false,
      code: 'need-more',
      bytes: 22 * 512,
    })
    expect(classifyAttachment(ole)).toMatchObject({ kind: 'document', mime: 'application/msword' })
  })

  it('keeps plain text that only looks a bit like mail headers as text', () => {
    expect(classifyAttachment(Buffer.from('Note: buy milk\nTodo: call\n\nmore'))).toMatchObject({
      kind: 'text',
    })
    expect(classifyAttachment(Buffer.from('{ "rtf": true }'))).toMatchObject({ kind: 'text' })
  })
})

describe('imageSize', () => {
  it('reads PNG, JPEG, GIF and WebP headers', () => {
    expect(imageSize(pngHeader(3000, 2000), 'image/png')).toEqual({ width: 3000, height: 2000 })
    expect(imageSize(jpegHeader(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 })
    expect(imageSize(Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1'), 'image/gif')).toEqual({
      width: 800,
      height: 600,
    })
    const vp8x = Buffer.alloc(30)
    vp8x.write('RIFF', 0, 'latin1')
    vp8x.write('WEBPVP8X', 8, 'latin1')
    vp8x.writeUIntLE(1999, 24, 3)
    vp8x.writeUIntLE(999, 27, 3)
    expect(imageSize(vp8x, 'image/webp')).toEqual({ width: 2000, height: 1000 })
  })

  it('gives null for truncated or malformed headers', () => {
    expect(imageSize(pngHeader(1, 1).subarray(0, 20), 'image/png')).toBeNull()
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00]), 'image/jpeg')).toBeNull()
    expect(imageSize(Buffer.from('RIFF'), 'image/webp')).toBeNull()
  })
})

describe('prepareImage', () => {
  const scaler = () => {
    const scale = vi.fn<ImageScaler['scale']>((_bytes, mime) =>
      Promise.resolve({ bytes: Buffer.from('scaled'), mime }),
    )
    return { scale, scaler: { scale } satisfies ImageScaler }
  }

  it('keeps an image that already fits', async () => {
    const s = scaler()
    const bytes = pngHeader(1568, 800)
    expect(await prepareImage(bytes, 'image/png', s.scaler)).toEqual({
      ok: true,
      bytes,
      mime: 'image/png',
    })
    expect(s.scale).not.toHaveBeenCalled()
  })

  it(`scales a bigger image to ${String(ATTACHMENT_LIMITS.imageMaxSide)}px on its longest side`, async () => {
    const s = scaler()
    const result = await prepareImage(pngHeader(1000, 4000), 'image/png', s.scaler)
    expect(s.scale).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 1568)
    expect(result).toEqual({ ok: true, bytes: Buffer.from('scaled'), mime: 'image/png' })
  })

  it('refuses decompression bombs before decoding', async () => {
    const s = scaler()
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 1
    expect(await prepareImage(pngHeader(side, side), 'image/png', s.scaler)).toMatchObject({
      ok: false,
      code: 'too-large',
    })
    expect(s.scale).not.toHaveBeenCalled()
  })

  it('refuses a big image the scaler cannot decode, and unreadable headers', async () => {
    const none: ImageScaler = { scale: () => Promise.resolve(null) }
    expect(await prepareImage(pngHeader(4000, 10), 'image/png', none)).toMatchObject({
      ok: false,
      code: 'too-large',
    })
    expect(await prepareImage(Buffer.from('GIF89a'), 'image/gif', none)).toMatchObject({
      ok: false,
      code: 'invalid',
    })
  })
})

describe('pdfPageCount', () => {
  it('reads the page tree count, taking the root (largest) /Count', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
        '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 120 >> endobj\n' +
        '3 0 obj << /Count 60 /Type /Pages /Parent 2 0 R >> endobj\n',
    )
    expect(pdfPageCount(pdf)).toBe(120)
  })

  it('gives null when the page tree is compressed (only the size limit applies)', () => {
    expect(
      pdfPageCount(Buffer.from('%PDF-1.7\n1 0 obj << /Type /ObjStm /N 3 >> stream\nxyz')),
    ).toBe(null)
  })

  it('stays fast on hostile input', () => {
    const hostile = Buffer.from(`%PDF-1.4\n${'/Type /Pages '.repeat(200_000)}`)
    const started = performance.now()
    expect(pdfPageCount(hostile)).toBeNull()
    expect(performance.now() - started).toBeLessThan(5000)
  })
})
