import type { DocumentKind } from './types'

/**
 * A small EXIF reader: just the tags the reader reports (capture time, camera,
 * orientation, GPS). Every read is bounds-checked, IFD offsets are visited once, and
 * entry counts are capped, so a hostile header can't loop or read out of range.
 */

export interface ExifInfo {
  orientation?: number
  capturedAt?: string
  make?: string
  model?: string
  software?: string
  gps?: { latitude: number; longitude: number; altitude?: number }
}

const MAX_ENTRIES = 512
const TAG = {
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  software: 0x0131,
  dateTime: 0x0132,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  dateTimeOriginal: 0x9003,
  gpsLatRef: 1,
  gpsLat: 2,
  gpsLonRef: 3,
  gpsLon: 4,
  gpsAltRef: 5,
  gpsAlt: 6,
} as const
/** Bytes per component of each TIFF field type. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

/**
 * The TIFF block holding EXIF data inside an image file, or null if it has none. Every
 * segment or chunk must fit inside its container (the file, or the RIFF chunk for
 * WebP); one that claims to run past it means a damaged file, and no EXIF is read.
 */
export function findExif(bytes: Uint8Array, kind: DocumentKind): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (kind === 'tiff') return bytes
  if (kind === 'jpeg') {
    let at = 2
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1] ?? 0
      if (marker === 0xda || marker === 0xd9) return null
      const length = view.getUint16(at + 2)
      const end = at + 2 + length
      if (length < 2 || end > bytes.length) return null
      if (marker === 0xe1 && length >= 8) {
        const id = String.fromCharCode(...bytes.subarray(at + 4, at + 10))
        if (id === 'Exif\0\0') return bytes.subarray(at + 10, end)
      }
      at = end
    }
    return null
  }
  if (kind === 'png') {
    let at = 8
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at)
      // Length, type, data, CRC.
      if (at + 12 + length > bytes.length) return null
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
      if (type === 'eXIf') return bytes.subarray(at + 8, at + 8 + length)
      if (type === 'IDAT' || type === 'IEND') return null
      at += 12 + length
    }
    return null
  }
  if (kind === 'webp') {
    if (bytes.length < 12) return null
    // The RIFF chunk's size counts from byte 8.
    const riffEnd = 8 + view.getUint32(4, true)
    if (riffEnd > bytes.length) return null
    let at = 12
    while (at + 8 <= riffEnd) {
      const type = String.fromCharCode(...bytes.subarray(at, at + 4))
      const length = view.getUint32(at + 4, true)
      if (at + 8 + length > riffEnd) return null
      if (type === 'EXIF') {
        const chunk = bytes.subarray(at + 8, at + 8 + length)
        // Some writers keep the JPEG-style "Exif\0\0" prefix.
        return String.fromCharCode(...chunk.subarray(0, 6)) === 'Exif\0\0'
          ? chunk.subarray(6)
          : chunk
      }
      at += 8 + length + (length & 1)
    }
    return null
  }
  return null
}

export function readExif(bytes: Uint8Array, kind: DocumentKind): ExifInfo | null {
  const tiff = findExif(bytes, kind)
  if (!tiff || tiff.length < 8) return null
  try {
    return parseTiff(tiff)
  } catch {
    return null
  }
}

type Value = number | number[] | string

function parseTiff(tiff: Uint8Array): ExifInfo | null {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const order = String.fromCharCode(tiff[0] ?? 0, tiff[1] ?? 0)
  if (order !== 'II' && order !== 'MM') return null
  const little = order === 'II'
  if (view.getUint16(2, little) !== 42) return null
  const visited = new Set<number>()

  const readIfd = (offset: number): Map<number, Value> => {
    const tags = new Map<number, Value>()
    if (visited.has(offset) || offset + 2 > tiff.length) return tags
    visited.add(offset)
    const count = Math.min(view.getUint16(offset, little), MAX_ENTRIES)
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12
      if (entry + 12 > tiff.length) break
      const value = readValue(entry)
      if (value !== undefined) tags.set(view.getUint16(entry, little), value)
    }
    return tags
  }

  const readValue = (entry: number): Value | undefined => {
    const type = view.getUint16(entry + 2, little)
    const count = view.getUint32(entry + 4, little)
    const size = TYPE_SIZE[type]
    if (!size || count === 0 || count > 256) return undefined
    const total = size * count
    const at = total <= 4 ? entry + 8 : view.getUint32(entry + 8, little)
    if (at + total > tiff.length) return undefined
    if (type === 2) {
      const raw = tiff.subarray(at, at + count)
      const end = raw.indexOf(0)
      return new TextDecoder().decode(end >= 0 ? raw.subarray(0, end) : raw).trim()
    }
    const values: number[] = []
    for (let i = 0; i < count; i++) {
      const p = at + i * size
      switch (type) {
        case 3:
          values.push(view.getUint16(p, little))
          break
        case 4:
          values.push(view.getUint32(p, little))
          break
        case 9:
          values.push(view.getInt32(p, little))
          break
        case 5:
        case 10: {
          const read = type === 5 ? view.getUint32.bind(view) : view.getInt32.bind(view)
          const denominator = read(p + 4, little)
          values.push(denominator ? read(p, little) / denominator : 0)
          break
        }
        default:
          values.push(tiff[p] ?? 0)
      }
    }
    return values.length === 1 ? (values[0] ?? 0) : values
  }

  const ifd0 = readIfd(view.getUint32(4, little))
  const pointer = (tags: Map<number, Value>, tag: number): Map<number, Value> => {
    const value = tags.get(tag)
    return typeof value === 'number' ? readIfd(value) : new Map<number, Value>()
  }
  const exif = pointer(ifd0, TAG.exifIfd)
  const gpsTags = pointer(ifd0, TAG.gpsIfd)
  const text = (tags: Map<number, Value>, tag: number): string | undefined => {
    const value = tags.get(tag)
    return typeof value === 'string' && value ? value.slice(0, 200) : undefined
  }

  const info: ExifInfo = {}
  const orientation = ifd0.get(TAG.orientation)
  if (typeof orientation === 'number' && orientation >= 1 && orientation <= 8) {
    info.orientation = orientation
  }
  const captured = text(exif, TAG.dateTimeOriginal) ?? text(ifd0, TAG.dateTime)
  if (captured) info.capturedAt = captured
  const make = text(ifd0, TAG.make)
  if (make) info.make = make
  const model = text(ifd0, TAG.model)
  if (model) info.model = model
  const software = text(ifd0, TAG.software)
  if (software) info.software = software
  const latitude = degrees(gpsTags.get(TAG.gpsLat), text(gpsTags, TAG.gpsLatRef), 'S')
  const longitude = degrees(gpsTags.get(TAG.gpsLon), text(gpsTags, TAG.gpsLonRef), 'W')
  if (latitude !== null && longitude !== null) {
    info.gps = { latitude, longitude }
    const altitude = gpsTags.get(TAG.gpsAlt)
    if (typeof altitude === 'number') {
      info.gps.altitude = gpsTags.get(TAG.gpsAltRef) === 1 ? -altitude : altitude
    }
  }
  return Object.keys(info).length ? info : null
}

function degrees(
  value: Value | undefined,
  ref: string | undefined,
  negative: string,
): number | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const [d = 0, m = 0, s = 0] = value
  const result = d + m / 60 + s / 3600
  if (!Number.isFinite(result)) return null
  return Math.round((ref === negative ? -result : result) * 1e6) / 1e6
}

/** The EXIF facts as text lines for the model. GPS only when the caller asked for location. */
export function describeExif(info: ExifInfo, includeLocation: boolean): string {
  const lines: string[] = []
  if (info.capturedAt) lines.push(`Captured: ${info.capturedAt}`)
  const camera = [info.make, info.model].filter(Boolean).join(' ')
  if (camera) lines.push(`Camera: ${camera}`)
  if (info.software) lines.push(`Software: ${info.software}`)
  if (info.orientation && info.orientation !== 1) {
    lines.push(`Orientation: EXIF ${String(info.orientation)} (applied)`)
  }
  if (info.gps) {
    if (includeLocation) {
      const { latitude, longitude, altitude } = info.gps
      lines.push(
        `Location: ${String(latitude)}, ${String(longitude)}` +
          (altitude === undefined ? '' : ` (altitude ${altitude.toFixed(1)} m)`),
      )
    } else {
      lines.push('Location: recorded (not included; ask with include_location)')
    }
  }
  return lines.join('\n')
}
