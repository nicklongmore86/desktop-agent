// Generates the app's placeholder icon: assets/icon/icon.ico (16, 24, 32, 48, 64, 128 and 256 px,
// for the window, taskbar, .exe and installer) and assets/icon/icon.png (512 px, for the window
// and notifications at runtime). It is original artwork, drawn here from a few shapes: a chat
// bubble with three dots on a rounded square. No logo, name or asset of any vendor.
//
//   node scripts/generate-icon.mjs          writes the files
//   node scripts/generate-icon.mjs --check  exits 1 if the committed files differ from this script
//
// Pure Node (zlib only), deterministic: the same script always writes the same bytes, which
// scripts/generate-icon.test.mjs checks, so the committed icon and this source cannot drift.
// Replace the placeholder by editing the shapes below, or by committing a designed icon.ico and
// icon.png over these and deleting this script and its test.
import { deflateSync, crc32 } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
export const PNG_SIZE = 512
const SUPERSAMPLE = 4

const lerp = (a, b, t) => a + (b - a) * t
const BG_FROM = [0x3b, 0x3f, 0xd8]
const BG_TO = [0x7c, 0x3a, 0xed]
const WHITE = [255, 255, 255]
const DOT = [0x4f, 0x46, 0xe5]

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
  const negative = d1 < 0 || d2 < 0 || d3 < 0
  const positive = d1 > 0 || d2 > 0 || d3 > 0
  return !(negative && positive)
}

/** The colour at a point of the unit square: [r, g, b, a], or null outside the icon. */
function shade(x, y) {
  if (!inRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22)) return null
  for (const cx of [0.36, 0.5, 0.64])
    if ((x - cx) ** 2 + (y - 0.44) ** 2 <= 0.048 ** 2) return [...DOT, 255]
  if (
    inRoundRect(x, y, 0.2, 0.24, 0.8, 0.64, 0.1) ||
    inTriangle(x, y, [0.3, 0.6], [0.3, 0.82], [0.48, 0.6])
  )
    return [...WHITE, 255]
  const t = (x + y) / 2
  return [
    lerp(BG_FROM[0], BG_TO[0], t),
    lerp(BG_FROM[1], BG_TO[1], t),
    lerp(BG_FROM[2], BG_TO[2], t),
    255,
  ]
}

/** `size` x `size` RGBA pixels (top row first), antialiased by supersampling. */
export function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4)
  const samples = SUPERSAMPLE * SUPERSAMPLE
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const color = shade(
            (px + (sx + 0.5) / SUPERSAMPLE) / size,
            (py + (sy + 0.5) / SUPERSAMPLE) / size,
          )
          if (!color) continue
          r += color[0]
          g += color[1]
          b += color[2]
          a += color[3]
        }
      }
      const offset = (py * size + px) * 4
      if (a > 0) {
        // Un-premultiply: the colour of the covered part, with coverage as alpha.
        const covered = a / 255
        pixels[offset] = Math.round(r / covered)
        pixels[offset + 1] = Math.round(g / covered)
        pixels[offset + 2] = Math.round(b / covered)
        pixels[offset + 3] = Math.round(a / samples)
      }
    }
  }
  return pixels
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** A PNG file (8-bit RGBA, no interlace) of `size` x `size` pixels. */
export function encodePng(size, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(
      rows,
      y * (size * 4 + 1) + 1,
    )
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** An icon image as a BMP (DIB) entry, the form every Windows tool reads: BGRA bottom-up + mask. */
function encodeDib(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // the XOR image and the AND mask
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = ((size - 1 - y) * size + x) * 4
      xor[to] = rgba[from + 2]
      xor[to + 1] = rgba[from + 1]
      xor[to + 2] = rgba[from]
      xor[to + 3] = rgba[from + 3]
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  return Buffer.concat([header, xor, Buffer.alloc(maskRow * size)])
}

/** The .ico: small sizes as BMP, 256 px as PNG (as Windows itself writes them). */
export function buildIco() {
  const images = ICO_SIZES.map((size) => {
    const rgba = renderIcon(size)
    return { size, data: size >= 256 ? encodePng(size, rgba) : encodeDib(size, rgba) }
  })
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })
  return Buffer.concat([head, ...entries, ...images.map((image) => image.data)])
}

export function buildPng() {
  return encodePng(PNG_SIZE, renderIcon(PNG_SIZE))
}

const directory = fileURLToPath(new URL('../assets/icon/', import.meta.url))
export const ICON_FILES = { ico: `${directory}icon.ico`, png: `${directory}icon.png` }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputs = [
    [ICON_FILES.ico, buildIco()],
    [ICON_FILES.png, buildPng()],
  ]
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([file, data]) => {
      try {
        return !readFileSync(file).equals(data)
      } catch {
        return true
      }
    })
    if (stale.length > 0) {
      console.error(
        `Out of date, run "node scripts/generate-icon.mjs": ${stale.map(([f]) => f).join(', ')}`,
      )
      process.exit(1)
    }
  } else {
    mkdirSync(directory, { recursive: true })
    for (const [file, data] of outputs) writeFileSync(file, data)
  }
}
