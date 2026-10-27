/** The longest title a rename keeps. */
export const MAX_TITLE_LENGTH = 100

// Controls, format characters (bidi overrides and isolates, zero-width), lone
// surrogates, private use, and line/paragraph separators: none belong in a title.
export const UNSAFE_TITLE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu

/** One line of plain text: unsafe characters become spaces, runs of space collapse. */
export function sanitizeTitle(text: string, max = MAX_TITLE_LENGTH): string {
  const clean = text.replace(UNSAFE_TITLE_CHARS, ' ').replace(/\s+/gu, ' ').trim()
  const chars = Array.from(clean)
  return chars.length <= max
    ? clean
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
}
