/**
 * Text a server or provider supplied (model names, status and error messages) made safe to
 * show. Removed: control characters, every Unicode format character (category Cf: bidi
 * overrides and isolates, zero-width spaces, word joiner, soft hyphen, byte order mark, the
 * Mongolian selector, tag characters) and the few blank "filler" letters. Line breaks become
 * spaces. React still shows the result as plain text.
 *
 * Kept on purpose: variation selectors (U+FE00 to U+FE0F), which are not format characters and
 * give an emoji like a red heart its picture form, and a zero-width joiner that sits between
 * two emoji, so a family or a profession emoji stays one picture. A joiner anywhere else goes.
 * The cost: the tag characters inside a subdivision flag are dropped, so that flag shows as a
 * plain black flag.
 */

/** Code points that draw as nothing but are not format characters. */
const FILLERS = [0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0]
const hex = (code: number): string => '\\u{' + code.toString(16) + '}'

const BREAKS = new RegExp('[' + hex(10) + hex(13) + hex(9) + hex(0x2028) + hex(0x2029) + ']+', 'gu')
const PICTOGRAPH = '\\p{Extended_Pictographic}'
/** An emoji-joiner-emoji link (kept), or something to remove. */
const UNSAFE = new RegExp(
  '(' +
    PICTOGRAPH +
    hex(0xfe0f) +
    '?)' +
    hex(0x200d) +
    '(?=' +
    PICTOGRAPH +
    ')|[\\p{Cc}\\p{Cf}' +
    FILLERS.map(hex).join('') +
    ']',
  'gu',
)

export function plainText(text: string): string {
  return text
    .replace(BREAKS, ' ')
    .replace(UNSAFE, (match, emoji: string | undefined) => (emoji === undefined ? '' : match))
    .trim()
}
