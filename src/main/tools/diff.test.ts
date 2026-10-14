import { describe, expect, it } from 'vitest'
import { unifiedDiff } from './diff'

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${String(i + 1)}\n`).join('')

describe('unifiedDiff', () => {
  it('shows a new file as all additions against /dev/null', () => {
    const d = unifiedDiff(null, 'a\nb\n', 'x.txt')
    expect(d).toEqual({
      text: '--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n',
      added: 2,
      removed: 0,
    })
  })

  it('returns an empty diff for identical text', () => {
    expect(unifiedDiff('same\n', 'same\n', 'x').text).toBe('')
  })

  it('shows a one-line change with three lines of context', () => {
    const before = lines(10)
    const after = before.replace('line 5\n', 'LINE FIVE\n')
    expect(unifiedDiff(before, after, 'f').text).toBe(
      [
        '--- a/f',
        '+++ b/f',
        '@@ -2,7 +2,7 @@',
        ' line 2',
        ' line 3',
        ' line 4',
        '-line 5',
        '+LINE FIVE',
        ' line 6',
        ' line 7',
        ' line 8',
        '',
      ].join('\n'),
    )
  })

  it('splits distant changes into separate hunks', () => {
    const before = lines(30)
    const after = before.replace('line 2\n', 'two\n').replace('line 28\n', 'twenty-eight\n')
    const d = unifiedDiff(before, after, 'f')
    expect(d.text.match(/^@@/gm)).toHaveLength(2)
    expect(d.text).toContain('@@ -1,5 +1,5 @@')
    expect(d.text).toContain('@@ -25,6 +25,6 @@')
    expect(d).toMatchObject({ added: 2, removed: 2 })
  })

  it('handles insertions and deletions', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nc\nd\n', 'f')
    expect(d.text).toBe('--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n c\n+d\n')
  })

  it('marks a missing final newline like git does', () => {
    const d = unifiedDiff('a\nb\n', 'a\nb', 'f')
    expect(d.text).toBe(
      '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n',
    )
  })

  it('shows deleting everything', () => {
    expect(unifiedDiff('a\nb\n', '', 'f').text).toBe('--- a/f\n+++ b/f\n@@ -1,2 +0,0 @@\n-a\n-b\n')
  })

  it('produces a correct patch for large rewrites (falls back to a block replace)', () => {
    const before = lines(3000, 'old')
    const after = lines(3000, 'new')
    const d = unifiedDiff(before, after, 'f')
    expect(d).toMatchObject({ added: 3000, removed: 3000 })
    expect(d.text).toContain('@@ -1,3000 +1,3000 @@')
  })

  it('round-trips: applying the ops reproduces the new text', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\nsix\n'
    const after = 'zero\none\nthree\nfour\nFIVE\nsix\nseven\n'
    const d = unifiedDiff(before, after, 'f', 100)
    const rebuilt = d.text
      .split('\n')
      .slice(3)
      .filter((l) => l.startsWith(' ') || l.startsWith('+'))
      .map((l) => `${l.slice(1)}\n`)
      .join('')
    expect(rebuilt).toBe(after)
  })
})
