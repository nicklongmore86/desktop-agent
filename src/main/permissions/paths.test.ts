import { describe, expect, it } from 'vitest'
import { checkPathSyntax, isInside, samePath } from './paths'

describe('checkPathSyntax (win32)', () => {
  const ok = (p: string) => checkPathSyntax(p, 'win32')

  it('accepts plain absolute drive paths with either slash', () => {
    expect(ok('C:\\Users\\me\\Documents\\notes.txt')).toBeNull()
    expect(ok('c:/Users/me/Documents')).toBeNull()
    expect(ok('D:\\')).toBeNull()
    expect(ok('C:\\a\\..\\b\\.\\c')).toBeNull()
  })

  it('rejects network (UNC) paths', () => {
    expect(ok('\\\\server\\share\\file.txt')).toMatch(/UNC/)
    expect(ok('//server/share/file.txt')).toMatch(/UNC/)
  })

  it('rejects device and extended-length paths', () => {
    expect(ok('\\\\?\\C:\\Users\\me\\file.txt')).toMatch(/Device/)
    expect(ok('\\\\.\\C:\\Users\\me')).toMatch(/Device/)
    expect(ok('\\\\.\\PhysicalDrive0')).toMatch(/Device/)
    expect(ok('\\\\?\\UNC\\server\\share')).toMatch(/Device/)
    expect(ok('//?/C:/x')).toMatch(/Device/)
    expect(ok('\\??\\C:\\x')).toMatch(/Device/)
  })

  it('rejects relative, drive-relative and root-relative paths', () => {
    expect(ok('notes.txt')).toMatch(/absolute/)
    expect(ok('..\\secret')).toMatch(/absolute/)
    expect(ok('C:notes.txt')).toMatch(/absolute/)
    expect(ok('\\Users\\me')).toMatch(/absolute/)
  })

  it('rejects NTFS alternate data streams', () => {
    expect(ok('C:\\proj\\file.txt:hidden')).toMatch(/alternate data streams/)
    expect(ok('C:\\proj\\file.txt::$DATA')).toMatch(/alternate data streams/)
    expect(ok('C:\\proj:stream\\x')).toMatch(/alternate data streams/)
  })

  it('rejects reserved device names, with or without extension, in any case', () => {
    for (const name of [
      'CON',
      'nul',
      'Prn',
      'AUX',
      'COM1',
      'com9',
      'LPT1',
      'nul.txt',
      'CON .log',
      'conin$',
      'COM¹',
    ]) {
      expect(ok(`C:\\proj\\${name}`), name).toMatch(/reserved/)
    }
    expect(ok('C:\\proj\\console.txt')).toBeNull()
    expect(ok('C:\\proj\\com10')).toBeNull()
  })

  it('rejects names with trailing dots or spaces, which Windows strips', () => {
    expect(ok('C:\\proj\\.env.')).toMatch(/dot or space/)
    expect(ok('C:\\proj\\key.pem ')).toMatch(/dot or space/)
    expect(ok('C:\\proj\\dir.\\file')).toMatch(/dot or space/)
  })

  it('rejects wildcard and other invalid characters', () => {
    expect(ok('C:\\proj\\*.txt')).toMatch(/characters/)
    expect(ok('C:\\proj\\a?b')).toMatch(/characters/)
    expect(ok('C:\\proj\\a\u0001b')).toMatch(/characters/)
  })

  it('rejects empty paths and NUL characters', () => {
    expect(ok('')).toMatch(/empty/)
    expect(ok('C:\\proj\\a\0b')).toMatch(/NUL/)
  })
})

describe('checkPathSyntax (posix)', () => {
  it('requires absolute paths and rejects NUL', () => {
    expect(checkPathSyntax('/home/me/file:with:colons', 'linux')).toBeNull()
    expect(checkPathSyntax('relative/x', 'linux')).toMatch(/absolute/)
    expect(checkPathSyntax('/home/a\0b', 'darwin')).toMatch(/NUL/)
  })
})

describe('isInside', () => {
  it('matches the root itself and descendants only', () => {
    expect(isInside('/home/me/proj', '/home/me/proj', 'linux')).toBe(true)
    expect(isInside('/home/me/proj/a/b', '/home/me/proj', 'linux')).toBe(true)
    expect(isInside('/home/me/proj-evil/a', '/home/me/proj', 'linux')).toBe(false)
    expect(isInside('/home/me', '/home/me/proj', 'linux')).toBe(false)
    expect(isInside('/home/me/proj/..foo', '/home/me/proj', 'linux')).toBe(true)
  })

  it('is case-sensitive on Linux and case-insensitive on Windows and macOS', () => {
    expect(isInside('/home/me/PROJ/a', '/home/me/proj', 'linux')).toBe(false)
    expect(isInside('/Users/me/PROJ/a', '/Users/me/proj', 'darwin')).toBe(true)
    expect(isInside('c:\\USERS\\me\\Proj\\a', 'C:\\Users\\me\\proj', 'win32')).toBe(true)
  })

  it('never matches across Windows drives', () => {
    expect(isInside('D:\\Users\\me\\proj', 'C:\\Users\\me\\proj', 'win32')).toBe(false)
  })
})

describe('samePath', () => {
  it('folds case only where the platform does', () => {
    expect(samePath('C:\\A\\b', 'c:\\a\\B', 'win32')).toBe(true)
    expect(samePath('/a/b', '/a/B', 'linux')).toBe(false)
  })
})
