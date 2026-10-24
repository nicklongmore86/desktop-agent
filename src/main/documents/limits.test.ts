import { describe, expect, it } from 'vitest'
import { jpegShell, pngShell } from './fixtures.test-util'
import { checkDocumentSize, checkPixels, DEFAULT_LIMITS, imageDimensions } from './limits'
import { DocumentError } from './types'

const code = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return error instanceof DocumentError ? error.code : 'other'
  }
  return undefined
}

describe('limits', () => {
  it('caps the document size at 100 MB', () => {
    expect(DEFAULT_LIMITS.maxDocumentBytes).toBe(100 * 1024 * 1024)
    expect(
      code(() => {
        checkDocumentSize(100 * 1024 * 1024)
      }),
    ).toBeUndefined()
    expect(
      code(() => {
        checkDocumentSize(100 * 1024 * 1024 + 1)
      }),
    ).toBe('too-large')
  })

  it('caps decoded images at 100 megapixels', () => {
    expect(
      code(() => {
        checkPixels(10_000, 10_000)
      }),
    ).toBeUndefined()
    expect(
      code(() => {
        checkPixels(10_001, 10_000)
      }),
    ).toBe('too-many-pixels')
    expect(
      code(() => {
        checkPixels(0, 10)
      }),
    ).toBe('malformed')
    expect(
      code(() => {
        checkPixels(Number.NaN, 10)
      }),
    ).toBe('malformed')
  })

  it('reads dimensions from headers without decoding', () => {
    expect(imageDimensions(pngShell(640, 480), 'png')).toEqual({ width: 640, height: 480 })
    expect(imageDimensions(pngShell(0xffffffff, 0xffffffff), 'png')).toEqual({
      width: 0xffffffff,
      height: 0xffffffff,
    })
    expect(imageDimensions(jpegShell(1024, 768), 'jpeg')).toEqual({ width: 1024, height: 768 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x01, 0x10, 0x00])
    expect(imageDimensions(gif, 'gif')).toEqual({ width: 288, height: 16 })
    const bmp = new Uint8Array(26)
    const view = new DataView(bmp.buffer)
    view.setUint32(14, 40, true)
    view.setInt32(18, 300, true)
    view.setInt32(22, -200, true)
    expect(imageDimensions(bmp, 'bmp')).toEqual({ width: 300, height: 200 })
    const vp8x = new Uint8Array(30)
    vp8x.set([0x56, 0x50, 0x38, 0x58], 12)
    vp8x.set([0xff, 0x03, 0x00, 0xff, 0x01, 0x00], 24)
    expect(imageDimensions(vp8x, 'webp')).toEqual({ width: 1024, height: 512 })
    const tiff = new Uint8Array([
      0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 2, 0, 0x00, 0x01, 3, 0, 1, 0, 0, 0, 0x20, 0x03, 0, 0, 0x01,
      0x01, 4, 0, 1, 0, 0, 0, 0x58, 0x02, 0, 0,
    ])
    expect(imageDimensions(tiff, 'tiff')).toEqual({ width: 800, height: 600 })
  })

  it('returns null for truncated headers', () => {
    expect(imageDimensions(pngShell(1, 1).subarray(0, 20), 'png')).toBeNull()
    expect(imageDimensions(jpegShell(1, 1).subarray(0, 8), 'jpeg')).toBeNull()
    expect(
      imageDimensions(new Uint8Array([0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0, 0]), 'tiff'),
    ).toBeNull()
    expect(imageDimensions(new Uint8Array(10), 'webp')).toBeNull()
  })

  it('trusts PNG and JPEG dimensions only behind a real header', () => {
    const forged = (at: number, value: number): Uint8Array => {
      const bytes = pngShell(640, 480)
      bytes[at] = value
      return bytes
    }
    // Every byte of the signature, the IHDR length (13) and the type 'IHDR' is checked.
    for (let at = 0; at < 16; at++) {
      expect(imageDimensions(forged(at, (pngShell(1, 1)[at] ?? 0) ^ 0x20), 'png')).toBeNull()
    }
    // Just the first two bytes of a PNG, with plausible dimensions where IHDR would be.
    const lookalike = new Uint8Array(33)
    lookalike.set([0x89, 0x50])
    new DataView(lookalike.buffer).setUint32(16, 640)
    new DataView(lookalike.buffer).setUint32(20, 480)
    expect(imageDimensions(lookalike, 'png')).toBeNull()
    // IHDR cut short of its 13 bytes, and garbage after a valid signature.
    expect(imageDimensions(pngShell(640, 480).subarray(0, 28), 'png')).toBeNull()
    const garbage = pngShell(640, 480)
    garbage.fill(0xab, 8)
    expect(imageDimensions(garbage, 'png')).toBeNull()

    // A JPEG needs SOI, then a frame header the walker finds.
    const noSoi = jpegShell(1024, 768)
    noSoi[1] = 0xd9
    expect(imageDimensions(noSoi, 'jpeg')).toBeNull()
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, ...new Uint8Array(30)]), 'jpeg')).toBeNull()
    const shortFrame = jpegShell(1024, 768)
    shortFrame[5] = 7
    expect(imageDimensions(shortFrame, 'jpeg')).toBeNull()
    const overrunFrame = jpegShell(1024, 768)
    overrunFrame[5] = 0x40
    expect(imageDimensions(overrunFrame, 'jpeg')).toBeNull()
  })
})
