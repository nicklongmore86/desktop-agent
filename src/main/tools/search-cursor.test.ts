import { describe, expect, it } from 'vitest'
import {
  afterCursor,
  cursorBinding,
  decodeCursor,
  encodeCursor,
  MAX_CURSOR_LENGTH,
  orderKey,
  positionBefore,
  SortedCapped,
} from './search-cursor'

describe('search cursor', () => {
  const binding = cursorBinding([
    '/root',
    null,
    'needle',
    false,
    false,
    100,
    20,
    true,
    1,
    5,
    'content',
  ])

  it('round-trips a position, and its text says nothing of it', () => {
    const position = { key: orderKey('docs/secret plan.pdf'), inclusive: true }
    const cursor = encodeCursor(position, binding)
    expect(cursor).toMatch(/^sf1\.[\w-]+$/)
    expect(cursor).not.toContain('secret')
    expect(Buffer.from(cursor.slice(4), 'base64url').toString('latin1')).not.toContain('secret')
    expect(decodeCursor(cursor, binding)).toEqual(position)
    // A new cursor each time, even for the same position.
    expect(encodeCursor(position, binding)).not.toBe(cursor)
  })

  it('refuses a cursor changed anywhere, or given by another search', () => {
    const cursor = encodeCursor({ key: 'a', inclusive: false }, binding)
    for (let i = 4; i < cursor.length; i++) {
      const flipped = cursor.slice(0, i) + (cursor[i] === 'A' ? 'B' : 'A') + cursor.slice(i + 1)
      expect(decodeCursor(flipped, binding)).toBeNull()
    }
    expect(decodeCursor(cursor.slice(0, -1), binding)).toBeNull()
    expect(decodeCursor(`${cursor}A`, binding)).toBeNull()
    // Another folder, pattern or option.
    for (const other of [
      cursorBinding(['/other', null, 'needle', false, false, 100, 20, true, 1, 5, 'content']),
      cursorBinding(['/root', null, 'needles', false, false, 100, 20, true, 1, 5, 'content']),
      cursorBinding(['/root', null, 'needle', false, true, 100, 20, true, 1, 5, 'content']),
      cursorBinding(['/root', null, 'needle', false, false, 100, 20, true, 1, 5, 'files']),
    ]) {
      expect(decodeCursor(cursor, other)).toBeNull()
    }
    for (const junk of ['', 'sf1.', 'sf1.!!!', 'sf2.AAAA', 'x'.repeat(MAX_CURSOR_LENGTH + 1)]) {
      expect(decodeCursor(junk, binding)).toBeNull()
    }
  })

  it('orders paths as the walk yields them: a folder, its entries, then its next sibling', () => {
    const rels = ['a-c', 'a/b', 'a', 'B', 'a/b/c', 'a.txt']
    expect(
      rels
        .map(orderKey)
        .sort()
        .map((k) => k.split('\u0000').join('/')),
    ).toEqual(['B', 'a', 'a/b', 'a/b/c', 'a-c', 'a.txt'])
  })

  it('compares positions: at a key comes before after it', () => {
    expect(afterCursor('b', null)).toBe(true)
    expect(afterCursor('b', { key: 'b', inclusive: true })).toBe(true)
    expect(afterCursor('b', { key: 'b', inclusive: false })).toBe(false)
    expect(afterCursor('a', { key: 'b', inclusive: true })).toBe(false)
    expect(positionBefore({ key: 'b', inclusive: true }, { key: 'b', inclusive: false })).toBe(true)
    expect(positionBefore({ key: 'b', inclusive: false }, { key: 'b', inclusive: true })).toBe(
      false,
    )
    expect(positionBefore({ key: 'a', inclusive: false }, { key: 'b', inclusive: true })).toBe(true)
  })
})

describe('SortedCapped', () => {
  it('keeps the first items in key order, whatever order they come in, and counts them all', () => {
    const list = new SortedCapped<{ key: string }>(50)
    const keys = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(5, '0'))
    // A fixed shuffle.
    let seed = 7
    const shuffled = [...keys].sort(() => ((seed = (seed * 16807) % 2147483647) % 3) - 1)
    for (const key of shuffled) list.add({ key })
    expect(list.items).toHaveLength(50)
    expect(list.items.map((i) => i.key)).toEqual(keys.slice(0, 50))
    expect(list.total).toBe(10_000)
    expect(list.overflowed).toBe(true)
  })

  it('cuts at a position', () => {
    const list = new SortedCapped<{ key: string }>(10)
    for (const key of ['d', 'a', 'c', 'b']) list.add({ key })
    expect(list.overflowed).toBe(false)
    expect(list.cutAt({ key: 'c', inclusive: false })).toBe(1)
    expect(list.items.map((i) => i.key)).toEqual(['a', 'b', 'c'])
    expect(list.cutAt({ key: 'b', inclusive: true })).toBe(2)
    expect(list.items.map((i) => i.key)).toEqual(['a'])
  })
})
