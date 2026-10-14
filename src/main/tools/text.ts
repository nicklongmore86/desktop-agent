// Text helpers shared by the file tools: decoding, binary detection, sizes.

export type DecodedText =
  | {
      binary: false
      text: string
      encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'latin1'
    }
  | { binary: true }

const SNIFF_BYTES = 8000

/**
 * Decodes file bytes for the model. Honours UTF-8 and UTF-16 byte-order marks
 * (PowerShell 5 writes UTF-16LE by default); a NUL byte or many control
 * characters means binary; invalid UTF-8 falls back to Latin-1, which keeps
 * legacy Windows-1252 files readable.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { binary: false, text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' }
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.subarray(0, swapped.length - (swapped.length % 2)).swap16()
    return { binary: false, text: swapped.toString('utf16le'), encoding: 'utf-16be' }
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { binary: false, text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' }
  }
  if (looksBinary(buf)) return { binary: true }
  try {
    return {
      binary: false,
      text: new TextDecoder('utf-8', { fatal: true }).decode(buf),
      encoding: 'utf-8',
    }
  } catch {
    return { binary: false, text: buf.toString('latin1'), encoding: 'latin1' }
  }
}

/** A NUL byte, or more than 10% control characters, in the first 8000 bytes. */
export function looksBinary(buf: Uint8Array): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES)
  let control = 0
  for (let i = 0; i < end; i++) {
    const byte = buf[i] ?? 0
    if (byte === 0) return true
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++
  }
  return end > 0 && control / end > 0.1
}

/** Splits text into lines, dropping the terminators (`\n` or `\r\n`). */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Shortens one line of output for listings. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
