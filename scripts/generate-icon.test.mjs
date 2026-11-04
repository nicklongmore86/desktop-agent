import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildIco, buildPng, ICO_SIZES, ICON_FILES, PNG_SIZE } from './generate-icon.mjs'

it('the committed icon files are exactly what the generator writes', () => {
  expect(readFileSync(ICON_FILES.ico).equals(buildIco())).toBe(true)
  expect(readFileSync(ICON_FILES.png).equals(buildPng())).toBe(true)
})

it('generating twice gives the same bytes', () => {
  expect(buildIco().equals(buildIco())).toBe(true)
})

it('the .ico has the standard Windows sizes, 256 px as PNG and the rest as BMP', () => {
  const ico = buildIco()
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  const count = ico.readUInt16LE(4)
  expect(count).toBe(ICO_SIZES.length)
  expect(ICO_SIZES).toEqual(expect.arrayContaining([16, 24, 32, 48, 64, 128, 256]))
  const sizes = []
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    const size = ico[entry] === 0 ? 256 : ico[entry]
    sizes.push(size)
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    expect(offset + length).toBeLessThanOrEqual(ico.length)
    const image = ico.subarray(offset, offset + length)
    if (size === 256) expect(image.subarray(1, 4).toString('ascii')).toBe('PNG')
    else expect(image.readUInt32LE(0)).toBe(40) // BITMAPINFOHEADER
  }
  expect(sizes).toEqual(ICO_SIZES)
})

it('the PNG is 512 px, and a real picture with transparent corners', () => {
  const png = readFileSync(ICON_FILES.png)
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
  expect(png.readUInt32BE(16)).toBe(PNG_SIZE)
  expect(png.readUInt32BE(20)).toBe(PNG_SIZE)
  expect(png.length).toBeGreaterThan(2000)
})
