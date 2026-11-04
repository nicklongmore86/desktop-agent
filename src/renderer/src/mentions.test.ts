import { describe, expect, it } from 'vitest'
import { couldBePath, splitMentions } from './mentions'

const mentions = (text: string, whole = false): string[] =>
  splitMentions(text, whole).flatMap((part) => (part.mention === undefined ? [] : [part.mention]))
const shown = (text: string, whole = false): string =>
  splitMentions(text, whole)
    .map((part) => part.text)
    .join('')

describe('what the renderer proposes to main', () => {
  it.each([
    [
      'See C:\\Users\\me\\Documents\\report.pdf for details.',
      ['C:\\Users\\me\\Documents\\report.pdf'],
    ],
    ['It is in C:/Users/me/a.txt, next.', ['C:/Users/me/a.txt']],
    ['Open (src/main/index.ts) now', ['src/main/index.ts']],
    ['Look at docs\\plan.docx.', ['docs\\plan.docx']],
    ['see src/main/files/ for more', ['src/main/files/']],
    ['error at src/app.ts:42:7', ['src/app.ts:42:7']],
    ['saved to "C:\\My Documents\\a b.txt" ok', ['C:\\My Documents\\a b.txt']],
    ['both a/b.txt and c/d.md', ['a/b.txt', 'c/d.md']],
  ])('%j', (text, expected) => {
    expect(mentions(text)).toEqual(expected)
  })

  it.each([
    'and/or something',
    'w/o the thing',
    'a 3/4 cup',
    'visit https://example.com/a/b.txt',
    'mail me@example.com',
    'see www.example.com/a.html',
    'run /usr/bin/env',
    'at ~/notes.txt',
    '\\\\server\\share\\a.txt',
    'file:///C:/Users/me/a.txt',
    'version 1.2.3',
    'notes.md in prose is not proposed',
    'a<b>c/d.txt',
  ])('does not propose anything in %j', (text) => {
    expect(mentions(text)).toEqual([])
  })

  it('keeps the text it is given, so plain text is never altered', () => {
    for (const text of [
      'See C:\\a\\b.txt, then "x/y.md" and (docs/z.md).',
      '  leading and trailing  ',
      'none here',
    ])
      expect(shown(text)).toBe(text)
  })

  it('proposes a whole list item or cell, with spaces, and falls back to its words', () => {
    const [part] = splitMentions('My Docs/budget plan.xlsx', true)
    expect(part?.mention).toBe('My Docs/budget plan.xlsx')
    expect(part?.alt?.map((p) => p.text).join('')).toBe('My Docs/budget plan.xlsx')
    expect(mentions('notes.md', true)).toEqual(['notes.md'])
    expect(mentions('C:\\Users\\Nick Longmore\\Documents', true)).toEqual([
      'C:\\Users\\Nick Longmore\\Documents',
    ])
    expect(mentions('Done.', true)).toEqual([])
    expect(mentions('Please see the docs', true)).toEqual([])
  })

  it('a bare file name is only proposed where the whole text is the name', () => {
    expect(couldBePath('notes.md', true)).toBe(true)
    expect(couldBePath('notes.md', false)).toBe(false)
    expect(couldBePath('a\u0007.txt', true)).toBe(false)
    expect(couldBePath('x'.repeat(2000) + '.txt', true)).toBe(false)
  })
})
