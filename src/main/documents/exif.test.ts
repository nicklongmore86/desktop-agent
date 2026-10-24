import { describe, expect, it } from 'vitest'
import { describeExif, readExif } from './exif'
import { jpegShell, makeExif, withExif } from './fixtures.test-util'

const photo = withExif(
  jpegShell(400, 200),
  makeExif({
    orientation: 6,
    make: 'Canon',
    model: 'EOS R6',
    dateTimeOriginal: '2026:07:14 09:30:12',
    gps: { lat: 51.5007, latRef: 'N', lon: 0.1246, lonRef: 'W', alt: 21.5 },
  }),
)

describe('EXIF reader', () => {
  it('reads capture time, camera, orientation and GPS', () => {
    const info = readExif(photo, 'jpeg')
    expect(info).toMatchObject({
      orientation: 6,
      make: 'Canon',
      model: 'EOS R6',
      capturedAt: '2026:07:14 09:30:12',
    })
    expect(info?.gps?.latitude).toBeCloseTo(51.5007, 3)
    expect(info?.gps?.longitude).toBeCloseTo(-0.1246, 3)
    expect(info?.gps?.altitude).toBeCloseTo(21.5, 1)
  })

  it('includes coordinates only when asked', () => {
    const info = readExif(photo, 'jpeg')
    if (!info) throw new Error('no EXIF')
    const without = describeExif(info, false)
    expect(without).toContain('Camera: Canon EOS R6')
    expect(without).toContain('Captured: 2026:07:14 09:30:12')
    expect(without).not.toMatch(/51\.5/)
    expect(describeExif(info, true)).toMatch(/Location: 51\.50\d+, -0\.12\d+/)
  })

  it('returns null without EXIF', () => {
    expect(readExif(jpegShell(1, 1), 'jpeg')).toBeNull()
  })

  it('survives hostile IFDs: loops, wild offsets, huge counts', () => {
    const tiff = makeExif({ orientation: 3 })
    const view = new DataView(tiff.buffer)
    // IFD0's next-IFD link and an extra pointer back to itself.
    view.setUint32(tiff.length - 4, 8, true)
    const loop = readExif(tiff, 'tiff')
    expect(loop?.orientation).toBe(3)

    const wild = new Uint8Array(tiff)
    new DataView(wild.buffer).setUint32(4, 0xfffffff0, true)
    expect(readExif(wild, 'tiff')).toBeNull()

    const huge = new Uint8Array(tiff)
    new DataView(huge.buffer).setUint16(8, 0xffff, true)
    expect(() => readExif(huge, 'tiff')).not.toThrow()
  })

  it('reads nothing from a segment or chunk that runs past its container', () => {
    const tiff = makeExif({ orientation: 6, make: 'Canon' })
    // JPEG: an APP1 segment claiming more bytes than the file has.
    const jpeg = withExif(jpegShell(10, 10), tiff)
    expect(readExif(jpeg, 'jpeg')?.orientation).toBe(6)
    const long = new Uint8Array(jpeg)
    new DataView(long.buffer).setUint16(4, jpeg.length, false)
    expect(readExif(long, 'jpeg')).toBeNull()

    // PNG: an eXIf chunk whose length runs past the end.
    const pngChunk = (length: number) => {
      const out = new Uint8Array(8 + 12 + tiff.length)
      out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const view = new DataView(out.buffer)
      view.setUint32(8, length)
      out.set([0x65, 0x58, 0x49, 0x66], 12)
      out.set(tiff, 16)
      return out
    }
    expect(readExif(pngChunk(tiff.length), 'png')?.orientation).toBe(6)
    expect(readExif(pngChunk(tiff.length + 1), 'png')).toBeNull()

    // WebP: an EXIF chunk inside the file but past the RIFF chunk's declared size.
    const webp = (riffSize: number) => {
      const out = new Uint8Array(12 + 8 + tiff.length)
      const view = new DataView(out.buffer)
      out.set([0x52, 0x49, 0x46, 0x46])
      view.setUint32(4, riffSize, true)
      out.set([0x57, 0x45, 0x42, 0x50, 0x45, 0x58, 0x49, 0x46], 8)
      view.setUint32(16, tiff.length, true)
      out.set(tiff, 20)
      return out
    }
    expect(readExif(webp(4 + 8 + tiff.length), 'webp')?.orientation).toBe(6)
    expect(readExif(webp(4 + 8 + tiff.length - 1), 'webp')).toBeNull()
  })

  it('reads no value from outside the EXIF segment, even if the file has bytes there', () => {
    const tiff = makeExif({ make: 'Canon' })
    // Point the make string just past the end of the segment, where the file continues.
    const view = new DataView(tiff.buffer)
    const entry = 8 + 2
    expect(view.getUint16(entry, true)).toBe(0x010f)
    view.setUint32(entry + 8, tiff.length, true)
    const jpeg = withExif(jpegShell(10, 10), tiff)
    const after = new TextEncoder().encode('Canon\0')
    const file = new Uint8Array(jpeg.length + after.length)
    file.set(jpeg)
    file.set(after, jpeg.length)
    expect(readExif(file, 'jpeg')?.make).toBeUndefined()
  })
})
