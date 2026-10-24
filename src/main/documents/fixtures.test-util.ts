import { deflateRawSync } from 'node:zlib'

/** A page for {@link makePdf}: lines of text (Helvetica 12pt) and/or a drawn grid of lines. */
export interface FixturePage {
  text?: string[]
  drawing?: boolean
  width?: number
  height?: number
}

/**
 * Builds a small, valid PDF in memory, so the tests carry no binary fixtures.
 * `encrypted` adds a Standard security handler whose user password is not empty,
 * which PDFium reports as a password error.
 */
export function makePdf(pages: FixturePage[], { encrypted = false } = {}): Uint8Array {
  const objects: string[] = []
  const add = (body: string): number => objects.push(body)
  const catalog = add('')
  const pageTree = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (const page of pages) {
    const width = page.width ?? 612
    const height = page.height ?? 792
    let content = ''
    if (page.text?.length) {
      content += `BT /F1 12 Tf 72 ${String(height - 72)} Td 14 TL\n`
      for (const line of page.text) content += `(${line.replace(/[()\\]/g, '\\$&')}) '\n`
      content += 'ET\n'
    }
    if (page.drawing) {
      content += '2 w 0 0 1 RG\n'
      for (let x = 100; x <= 500; x += 50) content += `${String(x)} 100 m ${String(x)} 600 l S\n`
      for (let y = 100; y <= 600; y += 50) content += `100 ${String(y)} m 500 ${String(y)} l S\n`
    }
    const stream = add(`<< /Length ${String(content.length)} >>\nstream\n${content}endstream`)
    kids.push(
      add(
        `<< /Type /Page /Parent ${String(pageTree)} 0 R /MediaBox [0 0 ${String(width)} ${String(height)}] ` +
          `/Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(stream)} 0 R >>`,
      ),
    )
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(pageTree)} 0 R >>`
  objects[pageTree - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${String(k)} 0 R`).join(' ')}] /Count ${String(kids.length)} >>`
  const hex32 = (seed: number): string =>
    Array.from({ length: 32 }, (_, i) =>
      ((i * 37 + seed) & 0xff).toString(16).padStart(2, '0'),
    ).join('')
  const encrypt = encrypted
    ? add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${hex32(1)}> /U <${hex32(2)}> >>`)
    : 0

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R`
  if (encrypt)
    out += ` /Encrypt ${String(encrypt)} 0 R /ID [<${hex32(3).slice(0, 32)}> <${hex32(3).slice(0, 32)}>]`
  out += ` >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** A ZIP local file + central directory for `entries` (deflated unless `stored`). */
export function makeZip(
  entries: { name: string; data: Uint8Array | string; stored?: boolean; declaredSize?: number }[],
): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = enc.encode(entry.name)
    const raw = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data
    const body = entry.stored ? raw : new Uint8Array(deflateRawSync(raw))
    const method = entry.stored ? 0 : 8
    const size = entry.declaredSize ?? raw.length
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local, body)
    centrals.push(central)
    offset += local.length + body.length
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const parts = [...locals, ...centrals, end]
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export interface FixtureExif {
  orientation?: number
  make?: string
  model?: string
  dateTimeOriginal?: string
  gps?: { lat: number; latRef: 'N' | 'S'; lon: number; lonRef: 'E' | 'W'; alt?: number }
}

interface Field {
  tag: number
  type: number
  count: number
  data: Uint8Array
}

const le = (size: number, values: number[]): Uint8Array => {
  const out = new Uint8Array(size * values.length)
  const view = new DataView(out.buffer)
  values.forEach((value, i) => {
    if (size === 2) view.setUint16(i * 2, value, true)
    else view.setUint32(i * 4, value, true)
  })
  return out
}
const asciiField = (tag: number, text: string): Field => {
  const data = new TextEncoder().encode(`${text}\0`)
  return { tag, type: 2, count: data.length, data }
}
const rationals = (tag: number, values: number[]): Field => ({
  tag,
  type: 5,
  count: values.length,
  data: le(
    4,
    values.flatMap((value) => [Math.round(value * 1000), 1000]),
  ),
})
const toDms = (value: number): number[] => {
  const d = Math.floor(value)
  const m = Math.floor((value - d) * 60)
  return [d, m, (value - d - m / 60) * 3600]
}

/** A little-endian TIFF block with the EXIF tags the reader looks at. */
export function makeExif(info: FixtureExif): Uint8Array {
  const ifd0: Field[] = []
  if (info.make) ifd0.push(asciiField(0x010f, info.make))
  if (info.model) ifd0.push(asciiField(0x0110, info.model))
  if (info.orientation)
    ifd0.push({ tag: 0x0112, type: 3, count: 1, data: le(2, [info.orientation]) })
  const exif: Field[] = info.dateTimeOriginal ? [asciiField(0x9003, info.dateTimeOriginal)] : []
  const gps: Field[] = []
  if (info.gps) {
    gps.push(asciiField(1, info.gps.latRef), rationals(2, toDms(info.gps.lat)))
    gps.push(asciiField(3, info.gps.lonRef), rationals(4, toDms(info.gps.lon)))
    if (info.gps.alt !== undefined) {
      gps.push(
        { tag: 5, type: 1, count: 1, data: new Uint8Array([0]) },
        rationals(6, [info.gps.alt]),
      )
    }
  }
  const ifdSize = (fields: Field[]): number => 2 + fields.length * 12 + 4
  const pointerCount = (exif.length ? 1 : 0) + (gps.length ? 1 : 0)
  const ifd0At = 8
  const exifAt = ifd0At + ifdSize(ifd0) + pointerCount * 12
  const gpsAt = exifAt + (exif.length ? ifdSize(exif) : 0)
  let dataAt = gpsAt + (gps.length ? ifdSize(gps) : 0)
  if (exif.length) ifd0.push({ tag: 0x8769, type: 4, count: 1, data: le(4, [exifAt]) })
  if (gps.length) ifd0.push({ tag: 0x8825, type: 4, count: 1, data: le(4, [gpsAt]) })

  const out = new Uint8Array(4096)
  const view = new DataView(out.buffer)
  out.set([0x49, 0x49, 0x2a, 0x00])
  view.setUint32(4, ifd0At, true)
  const writeIfd = (at: number, fields: Field[]): void => {
    view.setUint16(at, fields.length, true)
    fields.forEach((field, i) => {
      const entry = at + 2 + i * 12
      view.setUint16(entry, field.tag, true)
      view.setUint16(entry + 2, field.type, true)
      view.setUint32(entry + 4, field.count, true)
      if (field.data.length <= 4) {
        out.set(field.data, entry + 8)
      } else {
        view.setUint32(entry + 8, dataAt, true)
        out.set(field.data, dataAt)
        dataAt += field.data.length + (field.data.length & 1)
      }
    })
  }
  writeIfd(ifd0At, ifd0)
  if (exif.length) writeIfd(exifAt, exif)
  if (gps.length) writeIfd(gpsAt, gps)
  return out.slice(0, dataAt)
}

/** Puts an EXIF APP1 segment straight after a JPEG's SOI marker. */
export function withExif(jpeg: Uint8Array, tiff: Uint8Array): Uint8Array {
  const segment = new Uint8Array(4 + 6 + tiff.length)
  segment.set([0xff, 0xe1, (segment.length - 2) >> 8, (segment.length - 2) & 0xff])
  segment.set(new TextEncoder().encode('Exif\0\0'), 4)
  segment.set(tiff, 10)
  const out = new Uint8Array(jpeg.length + segment.length)
  out.set(jpeg.subarray(0, 2))
  out.set(segment, 2)
  out.set(jpeg.subarray(2), 2 + segment.length)
  return out
}

/** A JPEG's headers only (SOI, SOF0, EOI): enough for sniffing and dimension checks. */
export function jpegShell(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9,
  ])
}

/** A PNG's signature and IHDR chunk claiming the given size, with no pixel data. */
export function pngShell(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33)
  const view = new DataView(out.buffer)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  view.setUint32(16, width)
  view.setUint32(20, height)
  out.set([8, 6, 0, 0, 0], 24)
  return out
}
