import { describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS } from '../../shared/attachments'
import { classifyAttachment } from './classify'
import { imageSize, MAX_IMAGE_PIXELS, prepareImage, type ImageScaler } from './image'
import { pdfPageCount } from './pdf'
import { pngHeader } from './test-support'

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
    ['zip (and so docx/xlsx/pptx)', Buffer.from('PK\x03\x04\x14\x00\x00\x00\x08\x00', 'latin1')],
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
