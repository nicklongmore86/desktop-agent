/**
 * Text a server or provider supplied (model names, status and error messages) made safe to
 * show: control characters, bidirectional formatting characters (which can make text read
 * differently from what it is) and zero-width or invisible formatting characters become
 * nothing, and line breaks become spaces. React still shows the result as plain text.
 */

/** Code point ranges that draw nothing or reorder text, written as numbers so they stay visible. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], // C0 controls (tab, line feed and carriage return are handled apart)
  [0x0b, 0x1f],
  [0x7f, 0x9f], // delete and C1 controls
  [0xad, 0xad], // soft hyphen
  [0x61c, 0x61c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5],
  [0x180b, 0x180e], // Mongolian free variation selectors
  [0x200b, 0x200f], // zero-width characters and directional marks
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark / zero-width no-break space
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb], // interlinear annotation
]
const hex = (code: number): string =>
  String.fromCharCode(92) + 'u' + code.toString(16).padStart(4, '0')
const INVISIBLE = new RegExp(
  '[' + INVISIBLE_RANGES.map(([from, to]) => hex(from) + '-' + hex(to)).join('') + ']',
  'g',
)
const BREAKS = new RegExp('[' + hex(10) + hex(13) + hex(9) + hex(0x2028) + hex(0x2029) + ']+', 'g')

export function plainText(text: string): string {
  return text.replace(BREAKS, ' ').replace(INVISIBLE, '').trim()
}
