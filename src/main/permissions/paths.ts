import path from 'node:path'

export type PathApi = typeof path.posix

/** The `path` flavour for a platform, so Windows rules can be unit-tested on any OS. */
export function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix
}

/** NTFS and the default APFS volume ignore case; ext4 and friends do not. */
export function isCaseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

// CON, NUL, COM1... are devices in every directory, with or without an extension.
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i
// Characters Windows forbids in file names (plus ASCII control characters).
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const INVALID_WINDOWS_CHARS = /[<>"|?*\u0000-\u001f]/

/**
 * Checks the shape of a path without touching the file system. Returns why it
 * is unacceptable, or null if it is a plain absolute local path.
 *
 * On Windows this rejects network (UNC) paths, `\\?\` / `\\.\` device paths,
 * drive-relative paths (`C:foo`, `\foo`), alternate data streams (`file:stream`),
 * reserved device names (`NUL`, `com1.txt`) and names ending in a dot or space,
 * which Windows silently strips (so `.env.` would otherwise slip past the blocklist).
 */
export function checkPathSyntax(raw: string, platform: NodeJS.Platform): string | null {
  if (raw.length === 0) return 'Path is empty.'
  if (raw.includes('\0')) return 'Path contains a NUL character.'
  if (platform !== 'win32') {
    return raw.startsWith('/') ? null : `Path must be absolute (start with "/"): ${raw}`
  }

  const p = raw.replace(/\//g, '\\')
  if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\') || p.startsWith('\\??\\')) {
    return `Device and extended-length paths (\\\\?\\, \\\\.\\) are not allowed: ${raw}`
  }
  if (p.startsWith('\\\\')) return `Network (UNC) paths are not allowed: ${raw}`
  if (!/^[a-zA-Z]:\\/.test(p)) {
    return `Path must be absolute and start with a drive letter (e.g. C:\\Users\\you\\Documents): ${raw}`
  }
  for (const segment of p.slice(3).split('\\')) {
    if (segment === '' || segment === '.' || segment === '..') continue
    if (segment.includes(':')) {
      return `NTFS alternate data streams ("name:stream") are not allowed: ${raw}`
    }
    if (INVALID_WINDOWS_CHARS.test(segment)) {
      return `Path contains characters Windows does not allow in names (<>"|?*): ${raw}`
    }
    if (/[. ]$/.test(segment)) {
      return `Names ending in a dot or space are not allowed: "${segment}"`
    }
    const stem = (segment.split('.')[0] ?? '').trimEnd()
    if (RESERVED_DEVICE_NAME.test(stem)) {
      return `"${segment}" is a reserved Windows device name.`
    }
  }
  return null
}

/** Lower-cases a path when the platform compares paths case-insensitively. */
export function foldCase(p: string, platform: NodeJS.Platform): string {
  return isCaseInsensitive(platform) ? p.toLowerCase() : p
}

/** True when `child` is `parent` or inside it. Both must be absolute and normalized. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const P = pathApi(platform)
  const rel = P.relative(foldCase(parent, platform), foldCase(child, platform))
  if (rel === '') return true
  if (P.isAbsolute(rel)) return false // a different drive on Windows
  return rel !== '..' && !rel.startsWith(`..${P.sep}`)
}

/** True when two absolute, normalized paths name the same location. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const P = pathApi(platform)
  return foldCase(P.normalize(a), platform) === foldCase(P.normalize(b), platform)
}
