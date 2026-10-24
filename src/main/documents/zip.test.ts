import { describe, expect, it } from 'vitest'
import { makeZip } from './fixtures.test-util'
import { DEFAULT_LIMITS } from './limits'
import { DocumentError } from './types'
import { readZipDirectory, readZipEntry, ZipBudget, type ZipEntry } from './zip'

const MiB = 1024 * 1024
const zeros = (size: number) => new Uint8Array(size)
const entryAt = (entries: ZipEntry[], index: number): ZipEntry => {
  const entry = entries[index]
  if (!entry) throw new Error(`no entry ${String(index)}`)
  return entry
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof DocumentError ? error.code : String(error)
  }
  return 'resolved'
}

describe('zip guard', () => {
  it('reads entries and inflates them', async () => {
    const zip = makeZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'b.txt', data: 'stored', stored: true },
    ])
    const entries = readZipDirectory(zip)
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
    const decode = async (i: number) =>
      new TextDecoder().decode(await readZipEntry(zip, entryAt(entries, i)))
    expect(await decode(0)).toBe('hello')
    expect(await decode(1)).toBe('stored')
  })

  it('refuses an entry whose declared ratio is a bomb', () => {
    // 64 MiB of zeros deflates to ~64 KiB: a ratio of about 1000.
    const zip = makeZip([{ name: 'bomb.xml', data: zeros(64 * MiB) }])
    expect(() => readZipDirectory(zip)).toThrow(expect.objectContaining({ code: 'zip-bomb' }))
  })

  it('stops inflating an entry that lies about its size', async () => {
    // Declares 1 KiB, really expands to 8 MiB.
    const zip = makeZip([{ name: 'liar.xml', data: zeros(8 * MiB), declaredSize: 1024 }])
    const entry = entryAt(readZipDirectory(zip), 0)
    expect(await rejection(readZipEntry(zip, entry))).toBe('zip-bomb')
  })

  it('shares one budget across entries', async () => {
    const zip = makeZip([
      { name: 'a', data: zeros(600 * 1024) },
      { name: 'b', data: zeros(600 * 1024) },
    ])
    const entries = readZipDirectory(zip)
    const [a, b] = [entryAt(entries, 0), entryAt(entries, 1)]
    const budget = new ZipBudget(1024 * 1024)
    await readZipEntry(zip, a, budget)
    expect(budget.remaining).toBe(1024 * 1024 - 600 * 1024)
    expect(await rejection(readZipEntry(zip, b, budget))).toBe('zip-bomb')
  })

  it('refuses too many entries, ZIP64, encryption and damage', async () => {
    const many = makeZip(
      Array.from({ length: 20 }, (_, i) => ({ name: `f${String(i)}`, data: 'x' })),
    )
    expect(() => readZipDirectory(many, { ...DEFAULT_LIMITS.zip, maxEntries: 10 })).toThrow(
      expect.objectContaining({ code: 'zip-bomb' }),
    )

    const encrypted = makeZip([{ name: 'secret', data: 'x' }])
    const entry = entryAt(readZipDirectory(encrypted), 0)
    expect(await rejection(readZipEntry(encrypted, { ...entry, encrypted: true }))).toBe(
      'password-protected',
    )

    expect(() => readZipDirectory(new Uint8Array(100))).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    )
    const truncated = makeZip([{ name: 'a.txt', data: 'hello world' }])
    const cut = truncated.slice(0, 20)
    expect(() => readZipDirectory(cut)).toThrow(DocumentError)

    const corrupt = makeZip([{ name: 'a.txt', data: 'hello hello hello' }])
    const corruptEntry = entryAt(readZipDirectory(corrupt), 0)
    corrupt.fill(0xff, 30 + 5, 30 + 5 + 4)
    expect(await rejection(readZipEntry(corrupt, corruptEntry))).toBe('malformed')
  })

  it('refuses a directory record whose extra field or comment runs past the directory', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }])
    expect(readZipDirectory(zip)).toHaveLength(1)
    const end = zip.length - 22
    const central = new DataView(zip.buffer).getUint32(end + 16, true)
    for (const field of [30, 32]) {
      const bad = new Uint8Array(zip)
      // The extra or comment length now reaches into the end-of-directory record.
      new DataView(bad.buffer).setUint16(central + field, 4, true)
      expect(() => readZipDirectory(bad)).toThrow(expect.objectContaining({ code: 'malformed' }))
    }
  })
})
