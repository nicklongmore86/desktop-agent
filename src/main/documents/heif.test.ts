import { describe, expect, it } from 'vitest'
import { readExif } from './exif'
import { readHeif } from './heif'
import { PLAIN_HEIC, ROTATED_AVIF, ROTATED_HEIC, withIspe } from './heif-fixtures.test-util'
import { imageDimensions } from './limits'

describe('readHeif', () => {
  it('reads the stored size, the crop, irot as an orientation, and the Exif item', () => {
    for (const photo of [ROTATED_HEIC, ROTATED_AVIF]) {
      const info = readHeif(photo)
      expect(info?.cropped).toEqual({ width: 64, height: 32 })
      expect(info?.orientation).toBe(6)
      expect(info?.exif?.subarray(0, 4)).toEqual(new Uint8Array([0x4d, 0x4d, 0, 0x2a]))
    }
    // HEVC pads the stored picture; the decoder allocates that size.
    expect(readHeif(ROTATED_HEIC)?.coded).toEqual({ width: 64, height: 64 })
    expect(imageDimensions(ROTATED_HEIC, 'heic')).toEqual({ width: 64, height: 64 })
    expect(readHeif(PLAIN_HEIC)?.orientation).toBe(1)
  })

  it('reads EXIF facts from the Exif item', () => {
    expect(readExif(ROTATED_HEIC, 'heic')).toMatchObject({
      make: 'Apple',
      model: 'iPhone 15',
      capturedAt: '2026:05:01 10:20:30',
      gps: { latitude: 51.5, longitude: -0.125 },
    })
    expect(readExif(ROTATED_AVIF, 'avif')).toMatchObject({ model: 'iPhone 15' })
    expect(readExif(PLAIN_HEIC, 'heic')).toMatchObject({ make: 'Canon', model: 'EOS' })
  })

  it('reports what the header claims, however large', () => {
    expect(imageDimensions(withIspe(ROTATED_HEIC, 20_000, 10_000), 'heic')).toEqual({
      width: 20_000,
      height: 10_000,
    })
  })

  it('turns irot and imir into EXIF orientations', () => {
    const at = Buffer.from(ROTATED_HEIC).indexOf('irot') + 4
    const turned = (angle: number): Uint8Array => {
      const copy = new Uint8Array(ROTATED_HEIC)
      copy[at] = angle
      return copy
    }
    expect([0, 1, 2, 3].map((angle) => readHeif(turned(angle))?.orientation)).toEqual([1, 8, 3, 6])
  })

  it('returns null for damaged or hostile containers, never throwing', () => {
    expect(readHeif(new Uint8Array())).toBeNull()
    expect(readHeif(ROTATED_HEIC.subarray(0, 200))).toBeNull()
    // A box claiming to run past its parent.
    const long = new Uint8Array(ROTATED_HEIC)
    new DataView(long.buffer).setUint32(0x1c, 0x7fffffff)
    expect(readHeif(long)).toBeNull()
    // A 64-bit size past 2^53.
    const huge = new Uint8Array(ROTATED_HEIC)
    const view = new DataView(huge.buffer)
    view.setUint32(0x1c, 1)
    expect(readHeif(huge)).toBeNull()
    // Every prefix, and random corruption, is refused or read within bounds.
    for (let end = 0; end < ROTATED_HEIC.length; end += 7) {
      expect(() => readHeif(ROTATED_HEIC.subarray(0, end))).not.toThrow()
    }
    let seed = 7
    for (let round = 0; round < 500; round++) {
      const copy = new Uint8Array(ROTATED_HEIC)
      for (let i = 0; i < 4; i++) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31
        copy[seed % copy.length] = seed & 0xff
      }
      const info = readHeif(copy)
      if (info?.exif) {
        expect(info.exif.byteOffset + info.exif.length).toBeLessThanOrEqual(copy.length)
      }
    }
  })
})
