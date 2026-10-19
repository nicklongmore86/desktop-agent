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

/** A minimal .docx: [Content_Types].xml, then a word/ part after `padding` bytes of other parts. */
export function docx(padding = 0): Buffer {
  return zipEntries([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ...(padding > 0 ? [['docProps/thumbnail.jpeg', Buffer.alloc(padding, 1)] as const] : []),
    ['word/document.xml', '<w:document/>'],
  ])
}
