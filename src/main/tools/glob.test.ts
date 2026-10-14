import { describe, expect, it } from 'vitest'
import { globToRegExp } from './glob'

const matches = (glob: string, s: string, caseSensitive = false) =>
  globToRegExp(glob, caseSensitive).test(s)

describe('globToRegExp', () => {
  it('matches * within a segment and ? as one character', () => {
    expect(matches('*.ts', 'index.ts')).toBe(true)
    expect(matches('*.ts', 'index.tsx')).toBe(false)
    expect(matches('*.ts', 'src/index.ts')).toBe(false)
    expect(matches('file?.txt', 'file1.txt')).toBe(true)
    expect(matches('file?.txt', 'file10.txt')).toBe(false)
  })

  it('matches ** across segments', () => {
    expect(matches('src/**/*.md', 'src/README.md')).toBe(true)
    expect(matches('src/**/*.md', 'src/a/b/c.md')).toBe(true)
    expect(matches('src/**/*.md', 'docs/a.md')).toBe(false)
    expect(matches('**', 'a/b/c')).toBe(true)
  })

  it('supports classes, negated classes and braces', () => {
    expect(matches('[ab]*.txt', 'apple.txt')).toBe(true)
    expect(matches('[!ab]*.txt', 'apple.txt')).toBe(false)
    expect(matches('*.{ts,tsx}', 'App.tsx')).toBe(true)
    expect(matches('*.{ts,tsx}', 'App.js')).toBe(false)
  })

  it('escapes regex characters and reads backslashes as separators', () => {
    expect(matches('a+b(1).txt', 'a+b(1).txt')).toBe(true)
    expect(matches('a.txt', 'abtxt')).toBe(false)
    expect(matches('src\\*.ts', 'src/x.ts')).toBe(true)
  })

  it('is case-insensitive unless asked', () => {
    expect(matches('*.TXT', 'notes.txt')).toBe(true)
    expect(matches('*.TXT', 'notes.txt', true)).toBe(false)
  })
})
