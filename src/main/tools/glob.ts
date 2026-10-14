/**
 * Compiles a file-name glob to a RegExp. Supports `*` (within a segment),
 * `**` (across segments), `?`, `[abc]` / `[!abc]` and `{a,b}`. Patterns are
 * matched against `/`-separated relative paths; `\` in the pattern is read as
 * `/` so Windows-style patterns work.
 */
export function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  const glob = pattern.replace(/\\/g, '/')
  let out = ''
  let braceDepth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 2)
      if (close === -1) {
        out += '\\['
      } else {
        let body = glob.slice(i + 1, close)
        const negate = body.startsWith('!') || body.startsWith('^')
        if (negate) body = body.slice(1)
        out += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
        i = close
      }
    } else if (c === '{') {
      braceDepth++
      out += '(?:'
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--
      out += ')'
    } else if (c === ',' && braceDepth > 0) {
      out += '|'
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  out += ')'.repeat(braceDepth)
  return new RegExp(`^${out}$`, caseSensitive ? '' : 'i')
}
