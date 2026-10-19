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
})
