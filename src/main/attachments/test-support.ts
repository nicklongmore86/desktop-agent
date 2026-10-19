// Helpers for the attachments tests. Not imported by app code.

/** A PNG header (signature + IHDR) of the given size; enough for every check before decoding. */
export function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/** Zip local file entries, stored (uncompressed): enough for classifyAttachment's checks. */
export function zipEntries(entries: readonly (readonly [string, string | Buffer])[]): Buffer {
  return Buffer.concat(
    entries.map(([name, data]) => {
      const body = Buffer.from(data)
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt32LE(body.length, 18)
      header.writeUInt32LE(body.length, 22)
      header.writeUInt16LE(Buffer.byteLength(name, 'latin1'), 26)
      return Buffer.concat([header, Buffer.from(name, 'latin1'), body])
    }),
  )
}

/**
 * An OLE2 compound file header with 512-byte sectors whose directory starts at
 * `directorySector`, with the root entry's class id and the given stream names.
 */
export function oleFile(options: {
  classId?: string
  streams?: readonly string[]
  directorySector?: number
}): Buffer {
  const sector = options.directorySector ?? 0
  const b = Buffer.alloc((sector + 2) * 512)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0)
  b.writeUInt16LE(0x3e, 0x18)
  b.writeUInt16LE(3, 0x1a)
  b.writeUInt16LE(0xfffe, 0x1c)
  b.writeUInt16LE(9, 0x1e)
  b.writeUInt32LE(sector, 0x30)
  const directory = (sector + 1) * 512
  b.write('Root Entry', directory, 'utf16le')
  if (options.classId) {
    const [d1 = '', d2 = '', d3 = '', d4 = '', d5 = ''] = options.classId.split('-')
    Buffer.from(d1, 'hex')
      .reverse()
      .copy(b, directory + 0x50)
    Buffer.from(d2, 'hex')
      .reverse()
      .copy(b, directory + 0x54)
    Buffer.from(d3, 'hex')
      .reverse()
      .copy(b, directory + 0x56)
    Buffer.from(d4 + d5, 'hex').copy(b, directory + 0x58)
  }
  ;(options.streams ?? []).forEach((name, i) => {
    b.write(name, directory + 128 * (i + 1), 'utf16le')
  })
  return b
}

export const WORD_CLSID = '00020906-0000-0000-C000-000000000046'
export const MSI_CLSID = '000C1084-0000-0000-C000-000000000046'

export interface ZipOptions {
  /** Archive comment after the end record. */
  comment?: string
  /** Overrides written into the end record (for broken or ZIP64 archives). */
  eocd?: Partial<{ count: number; cdSize: number; cdOffset: number; disk: number }>
}

/** Per-entry fields of zipFile, written to both the local and the central header. */
export interface ZipEntryOptions {
  /** Central directory "disk number start". */
  disk?: number
  /** General-purpose bit flags (bit 0: encrypted). */
  flags?: number
  /** Compression method (99: AES). */
  method?: number
}

/** A real (stored) zip: local entries, the central directory and the end record. */
export function zipFile(
  entries: readonly (readonly [string, string | Buffer, ZipEntryOptions?])[],
  options: ZipOptions = {},
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data, entry = {}] of entries) {
    const local = zipEntries([[name, data]])
    local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(entry.method ?? 0, 8)
    const body = Buffer.from(data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(entry.method ?? 0, 10)
    central.writeUInt16LE(entry.disk ?? 0, 34)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(Buffer.byteLength(name, 'latin1'), 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, Buffer.from(name, 'latin1')]))
    locals.push(local)
    offset += local.length
  }
  const cd = Buffer.concat(centrals)
  const comment = Buffer.from(options.comment ?? '', 'latin1')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(options.eocd?.disk ?? 0, 4)
  eocd.writeUInt16LE(options.eocd?.count ?? entries.length, 8)
  eocd.writeUInt16LE(options.eocd?.count ?? entries.length, 10)
  eocd.writeUInt32LE(options.eocd?.cdSize ?? cd.length, 12)
  eocd.writeUInt32LE(options.eocd?.cdOffset ?? offset, 16)
  eocd.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...locals, cd, eocd, comment])
}

/** A minimal .docx: [Content_Types].xml, `padding` bytes of other parts, then word/document.xml. */
export function docx(padding = 0): Buffer {
  return zipFile([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ...(padding > 0 ? [['docProps/thumbnail.jpeg', Buffer.alloc(padding, 1)] as const] : []),
    ['word/document.xml', '<w:document/>'],
  ])
}

/** The sample classifyAttachment gets for a file read in full. */
export const whole = (bytes: Buffer) => ({ head: bytes, tail: bytes, size: bytes.length })
