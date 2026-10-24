/**
 * A small reader for the HEIF container (ISO/IEC 23008-12) that HEIC and AVIF photos use:
 * just what the reader needs before anything decodes the pixels. The primary item's stored
 * size (`ispe`), its clean-aperture crop (`clap`), rotation and mirror (`irot`, `imir`, as
 * an EXIF orientation) and its Exif block. Every read is bounds-checked against the box it
 * is in, boxes and items are counted, and nothing loops on a size of zero, so a hostile
 * file can only make it return null.
 */

export interface HeifInfo {
  /** The primary image's stored size: what a decoder allocates. */
  coded: { width: number; height: number }
  /** After the clean-aperture crop, before rotation. */
  cropped: { width: number; height: number }
  /** `irot` and `imir` as the EXIF orientation (1-8) that turns the stored image upright. */
  orientation: number
  /** The Exif item's TIFF block, or null when there is none. */
  exif: Uint8Array | null
}

interface Box {
  type: string
  /** Where the box's content starts (after its header) and ends. */
  start: number
  end: number
}

const MAX_BOXES = 4096
const MAX_ITEMS = 4096
/** An Exif block larger than this is not read. */
const MAX_EXIF_BYTES = 1024 * 1024

/**
 * EXIF orientation for an `irot` angle (quarter turns anticlockwise) followed by an
 * optional `imir` (axis 0: mirrored left to right; 1: top to bottom). MIAF applies the
 * crop, then the rotation, then the mirror.
 */
const ORIENTATION: Record<number, readonly [number, number, number]> = {
  // [no mirror, axis 0, axis 1]
  0: [1, 2, 4],
  1: [8, 7, 5],
  2: [3, 4, 2],
  3: [6, 5, 7],
}

class Reader {
  readonly view: DataView
  boxes = 0
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  u8(at: number, end: number): number {
    if (at + 1 > end) throw new RangeError('short')
    return this.view.getUint8(at)
  }
  u16(at: number, end: number): number {
    if (at + 2 > end) throw new RangeError('short')
    return this.view.getUint16(at)
  }
  u32(at: number, end: number): number {
    if (at + 4 > end) throw new RangeError('short')
    return this.view.getUint32(at)
  }
  /** An unsigned big-endian integer of 0, 4 or 8 bytes, within 2^53. */
  uint(at: number, size: number, end: number): number {
    if (size === 0) return 0
    if (size === 4) return this.u32(at, end)
    if (size === 8) {
      const high = this.u32(at, end)
      if (high > 0x1fffff) throw new RangeError('too big')
      return high * 2 ** 32 + this.u32(at + 4, end)
    }
    throw new RangeError('bad size')
  }

  /** The boxes in `[start, end)`, each inside it. */
  children(start: number, end: number): Box[] {
    const boxes: Box[] = []
    let at = start
    while (at + 8 <= end) {
      if (++this.boxes > MAX_BOXES) throw new RangeError('too many boxes')
      let size = this.u32(at, end)
      const type = String.fromCharCode(...this.bytes.subarray(at + 4, at + 8))
      let header = 8
      if (size === 1) {
        size = this.uint(at + 8, 8, end)
        header = 16
      } else if (size === 0) {
        size = end - at
      }
      if (size < header || at + size > end) throw new RangeError('box outside its parent')
      boxes.push({ type, start: at + header, end: at + size })
      at += size
    }
    return boxes
  }
}

const find = (boxes: Box[], type: string): Box | undefined => boxes.find((box) => box.type === type)

/** Reads the primary image's facts, or null when the container is missing or damaged. */
export function readHeif(bytes: Uint8Array): HeifInfo | null {
  try {
    return parse(new Reader(bytes))
  } catch {
    return null
  }
}

function parse(r: Reader): HeifInfo | null {
  const top = r.children(0, r.bytes.length)
  if (top[0]?.type !== 'ftyp') return null
  const meta = find(top, 'meta')
  if (!meta) return null
  // meta is a full box: version and flags first.
  const inMeta = r.children(meta.start + 4, meta.end)

  const pitm = find(inMeta, 'pitm')
  if (!pitm) return null
  const pitmVersion = r.u8(pitm.start, pitm.end)
  const primary =
    pitmVersion === 0 ? r.u16(pitm.start + 4, pitm.end) : r.u32(pitm.start + 4, pitm.end)

  const types = itemTypes(r, find(inMeta, 'iinf'))
  const properties = primaryProperties(r, find(inMeta, 'iprp'), primary)
  if (!properties) return null
  const ispe = properties.find((box) => box.type === 'ispe')
  if (!ispe) return null
  const coded = { width: r.u32(ispe.start + 4, ispe.end), height: r.u32(ispe.start + 8, ispe.end) }
  if (coded.width === 0 || coded.height === 0) return null

  let cropped = coded
  const clap = properties.find((box) => box.type === 'clap')
  if (clap) {
    const fraction = (at: number): number => {
      const denominator = r.u32(clap.start + at + 4, clap.end)
      return denominator ? r.u32(clap.start + at, clap.end) / denominator : 0
    }
    const width = Math.floor(fraction(0))
    const height = Math.floor(fraction(8))
    // A crop is never larger than the image; anything else is ignored.
    if (width >= 1 && height >= 1 && width <= coded.width && height <= coded.height) {
      cropped = { width, height }
    }
  }

  const irot = properties.find((box) => box.type === 'irot')
  const imir = properties.find((box) => box.type === 'imir')
  const angle = irot ? r.u8(irot.start, irot.end) & 3 : 0
  const mirror = imir ? (r.u8(imir.start, imir.end) & 1) + 1 : 0
  const orientation = ORIENTATION[angle]?.[mirror] ?? 1

  return { coded, cropped, orientation, exif: exifBlock(r, inMeta, types, primary) }
}

/** item id -> item type, from `iinf`'s `infe` entries (version 2 and 3). */
function itemTypes(r: Reader, iinf: Box | undefined): Map<number, string> {
  const types = new Map<number, string>()
  if (!iinf) return types
  const version = r.u8(iinf.start, iinf.end)
  const first = iinf.start + 4 + (version === 0 ? 2 : 4)
  for (const infe of r.children(first, iinf.end)) {
    if (infe.type !== 'infe' || types.size >= MAX_ITEMS) continue
    const infeVersion = r.u8(infe.start, infe.end)
    if (infeVersion < 2) continue
    const id = infeVersion === 2 ? r.u16(infe.start + 4, infe.end) : r.u32(infe.start + 4, infe.end)
    const typeAt = infe.start + (infeVersion === 2 ? 8 : 10)
    if (typeAt + 4 > infe.end) continue
    types.set(id, String.fromCharCode(...r.bytes.subarray(typeAt, typeAt + 4)))
  }
  return types
}

/** The property boxes `ipma` associates with `item`, in association order. */
function primaryProperties(r: Reader, iprp: Box | undefined, item: number): Box[] | null {
  if (!iprp) return null
  const inIprp = r.children(iprp.start, iprp.end)
  const ipco = find(inIprp, 'ipco')
  if (!ipco) return null
  const pool = r.children(ipco.start, ipco.end)
  const result: Box[] = []
  for (const ipma of inIprp.filter((box) => box.type === 'ipma')) {
    const version = r.u8(ipma.start, ipma.end)
    const wide = (r.u32(ipma.start, ipma.end) & 1) === 1
    const entries = r.u32(ipma.start + 4, ipma.end)
    if (entries > MAX_ITEMS) return null
    let at = ipma.start + 8
    for (let i = 0; i < entries; i++) {
      const id = version < 1 ? r.u16(at, ipma.end) : r.u32(at, ipma.end)
      at += version < 1 ? 2 : 4
      const count = r.u8(at, ipma.end)
      at += 1
      for (let j = 0; j < count; j++) {
        // The top bit marks an essential property; the rest is a 1-based index into ipco.
        const index = wide ? r.u16(at, ipma.end) & 0x7fff : r.u8(at, ipma.end) & 0x7f
        at += wide ? 2 : 1
        const property = pool[index - 1]
        if (id === item && property) result.push(property)
      }
    }
  }
  return result
}

/** The Exif item describing the primary image (or the only one), as its TIFF block. */
function exifBlock(
  r: Reader,
  inMeta: Box[],
  types: Map<number, string>,
  primary: number,
): Uint8Array | null {
  const exifItems = [...types].filter(([, type]) => type === 'Exif').map(([id]) => id)
  if (exifItems.length === 0) return null
  const describes = describedBy(r, find(inMeta, 'iref'), primary)
  const item = exifItems.find((id) => describes.has(id)) ?? exifItems[0]
  if (item === undefined) return null
  const data = itemData(r, inMeta, item)
  // An Exif item starts with the offset of the TIFF header past these four bytes.
  if (!data || data.length < 12) return null
  const skip = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0)
  const tiff = data.subarray(4 + skip)
  return tiff.length >= 8 ? tiff : null
}

/** Items with a `cdsc` (content describes) reference to `item`. */
function describedBy(r: Reader, iref: Box | undefined, item: number): Set<number> {
  const found = new Set<number>()
  if (!iref) return found
  const wide = r.u8(iref.start, iref.end) !== 0
  const size = wide ? 4 : 2
  const read = (at: number, end: number): number => (wide ? r.u32(at, end) : r.u16(at, end))
  for (const ref of r.children(iref.start + 4, iref.end)) {
    if (ref.type !== 'cdsc') continue
    const from = read(ref.start, ref.end)
    const count = r.u16(ref.start + size, ref.end)
    for (let i = 0; i < count; i++) {
      if (read(ref.start + size + 2 + i * size, ref.end) === item) found.add(from)
    }
  }
  return found
}

/** An item's bytes from `iloc`: in the file (construction method 0) or in `idat` (1). */
function itemData(r: Reader, inMeta: Box[], item: number): Uint8Array | null {
  const iloc = find(inMeta, 'iloc')
  if (!iloc) return null
  const end = iloc.end
  const version = r.u8(iloc.start, end)
  if (version > 2) return null
  let at = iloc.start + 4
  const sizes = r.u16(at, end)
  at += 2
  const offsetSize = sizes >> 12
  const lengthSize = (sizes >> 8) & 0xf
  const baseSize = (sizes >> 4) & 0xf
  const indexSize = version >= 1 ? sizes & 0xf : 0
  const count = version < 2 ? r.u16(at, end) : r.u32(at, end)
  at += version < 2 ? 2 : 4
  if (count > MAX_ITEMS) return null
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? r.u16(at, end) : r.u32(at, end)
    at += version < 2 ? 2 : 4
    let method = 0
    if (version >= 1) {
      method = r.u16(at, end) & 0xf
      at += 2
    }
    at += 2 // data_reference_index
    const base = r.uint(at, baseSize, end)
    at += baseSize
    const extents = r.u16(at, end)
    at += 2
    const parts: { offset: number; length: number }[] = []
    for (let e = 0; e < extents; e++) {
      at += indexSize
      const offset = r.uint(at, offsetSize, end)
      at += offsetSize
      const length = r.uint(at, lengthSize, end)
      at += lengthSize
      parts.push({ offset, length })
    }
    if (id !== item) continue
    if (method > 1 || parts.length !== 1) return null
    const [{ offset, length } = { offset: 0, length: 0 }] = parts
    let from = base + offset
    let limit = r.bytes.length
    if (method === 1) {
      const idat = find(inMeta, 'idat')
      if (!idat) return null
      from += idat.start
      limit = idat.end
    }
    // Length 0 means "to the end" of the container.
    const to = length === 0 ? limit : from + length
    if (to > limit || to - from > MAX_EXIF_BYTES) return null
    return r.bytes.subarray(from, to)
  }
  return null
}
