import { describe, expect, it } from 'vitest'
import { decodeText, looksBinary, splitLines } from './text'

describe('decodeText', () => {
  it('decodes UTF-8, with and without a BOM', () => {
    expect(decodeText(Buffer.from('héllo'))).toEqual({
      binary: false,
      text: 'héllo',
      encoding: 'utf-8',
    })
    expect(decodeText(Buffer.from('\uFEFFhéllo'))).toEqual({
      binary: false,
      text: 'héllo',
      encoding: 'utf-8-bom',
    })
  })

  it('decodes UTF-16 with a BOM (PowerShell 5 output)', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi ✓', 'utf16le')])
    expect(decodeText(le)).toEqual({ binary: false, text: 'hi ✓', encoding: 'utf-16le' })
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hi', 'utf16le').swap16()])
    expect(decodeText(be)).toEqual({ binary: false, text: 'hi', encoding: 'utf-16be' })
  })

  it('falls back to Latin-1 for legacy single-byte text', () => {
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toEqual({
      binary: false,
      text: 'café',
      encoding: 'latin1',
    })
  })

  it('detects binary data', () => {
    expect(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toEqual(
      {
        binary: true,
      },
    )
    expect(looksBinary(Buffer.from([1, 2, 3, 4, 5, 6, 65]))).toBe(true)
    expect(looksBinary(Buffer.from('plain\ttext\r\n'))).toBe(false)
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
  })
})

describe('splitLines', () => {
  it('splits on LF and CRLF and ignores one trailing newline', () => {
    expect(splitLines('a\r\nb\nc\n')).toEqual(['a', 'b', 'c'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
    expect(splitLines('')).toEqual([])
  })
})
