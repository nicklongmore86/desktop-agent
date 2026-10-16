import { describe, expect, it } from 'vitest'
import tokens from './tokens.css?raw'

type Palette = Record<string, string>

/** `--color-name: #rrggbb;` declarations inside the first block that follows `selector`. */
function palette(selector: string): Palette {
  const start = tokens.indexOf(selector)
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0)
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start))
  const result: Palette = {}
  for (const match of body.matchAll(/(--color-[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi))
    result[match[1] as string] = (match[2] as string).toLowerCase()
  return result
}

const light = palette(':root {')
const darkSystem = palette(":root:not([data-theme='light']) {")
const darkForced = palette(":root[data-theme='dark'] {")

const channel = (value: number): number => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** [foreground, background, minimum ratio]: 4.5 for text (WCAG AA), 3 for UI outlines and the focus ring. */
const SURFACES = ['--color-surface-0', '--color-surface-1', '--color-surface-2']
const PAIRS: [string, string, number][] = [
  ...SURFACES.flatMap((s): [string, string, number][] => [
    ['--color-text', s, 4.5],
    ['--color-text-muted', s, 4.5],
  ]),
  ...[...SURFACES, '--color-accent-bg'].map((s): [string, string, number] => [
    '--color-accent-text',
    s,
    4.5,
  ]),
  ['--color-on-accent', '--color-accent', 4.5],
  ['--color-on-accent', '--color-accent-hover', 4.5],
  ['--color-text', '--color-accent-bg', 4.5],
  ['--color-text-muted', '--color-accent-bg', 4.5],
  ['--color-on-danger', '--color-danger', 4.5],
  ['--color-danger-text', '--color-surface-0', 4.5],
  ['--color-danger-text', '--color-surface-1', 4.5],
  ['--color-danger-text', '--color-danger-bg', 4.5],
  ['--color-text', '--color-danger-bg', 4.5],
  ['--color-warning-text', '--color-surface-0', 4.5],
  ['--color-warning-text', '--color-warning-bg', 4.5],
  ['--color-text', '--color-warning-bg', 4.5],
  ['--color-success-text', '--color-surface-0', 4.5],
  ['--color-success-text', '--color-success-bg', 4.5],
  ['--color-diff-add-text', '--color-diff-add-bg', 4.5],
  ['--color-diff-del-text', '--color-diff-del-bg', 4.5],
  ...['comment', 'keyword', 'string', 'number', 'title', 'attr', 'meta'].flatMap(
    (name): [string, string, number][] =>
      SURFACES.map((surface): [string, string, number] => [`--color-hl-${name}`, surface, 4.5]),
  ),
  ...['doc', 'sheet', 'slide', 'pdf', 'code', 'image', 'media', 'archive'].flatMap(
    (name): [string, string, number][] =>
      [...SURFACES, '--color-accent-bg'].map((surface): [string, string, number] => [
        `--color-ft-${name}`,
        surface,
        4.5,
      ]),
  ),
  ['--color-border-control', '--color-surface-0', 3],
  ['--color-border-control', '--color-surface-1', 3],
  ['--color-accent', '--color-surface-0', 3],
  ['--color-accent', '--color-surface-1', 3],
]

describe.each([
  ['light', light],
  ['dark (system)', darkSystem],
  ['dark (forced)', darkForced],
])('%s theme contrast', (_name, colors) => {
  it.each(PAIRS)('%s on %s is at least %s:1', (fg, bg, minimum) => {
    const fgColor = colors[fg]
    const bgColor = colors[bg]
    expect(fgColor, fg).toBeDefined()
    expect(bgColor, bg).toBeDefined()
    expect(contrast(fgColor as string, bgColor as string)).toBeGreaterThanOrEqual(minimum)
  })
})

describe('theme blocks', () => {
  it('keep the two dark blocks identical and only override roles the light theme defines', () => {
    expect(darkForced).toEqual(darkSystem)
    for (const name of Object.keys(darkSystem)) expect(light, name).toHaveProperty(name)
  })

  it('forces the colour scheme with the theme', () => {
    expect(tokens).toMatch(/:root\s*\{\s*color-scheme:\s*light;/)
    expect(tokens).toMatch(/:root\[data-theme='dark'\]\s*\{\s*color-scheme:\s*dark;/)
  })
})

/** Every token tokens.css declares, e.g. `--radius-sm`. */
const DEFINED = new Set(
  [...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1] as string),
)

/** CSS named colours; any of these as a value is a literal colour. */
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet ' +
    'brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan ' +
    'darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue ' +
    'darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey ' +
    'dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray ' +
    'green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush ' +
    'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray ' +
    'lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin ' +
    'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna ' +
    'silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle ' +
    'tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
)

/**
 * CSS system colour keywords (current and deprecated). They follow the user's
 * OS palette, so they are only right in a forced-colors (High Contrast) block.
 */
const SYSTEM_COLORS = new Set(
  (
    'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext ' +
    'field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem ' +
    'selecteditemtext visitedtext activeborder activecaption appworkspace background ' +
    'buttonhighlight buttonshadow captiontext inactiveborder inactivecaption inactivecaptiontext ' +
    'infobackground infotext menu menutext scrollbar threeddarkshadow threedface threedhighlight ' +
    'threedlightshadow threedshadow window windowframe windowtext'
  ).split(' '),
)

const COLOR_FUNCTIONS =
  /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(/i

/**
 * The `property: value` declarations of a stylesheet, comments removed (so they
 * neither hide nor trigger a match). Selectors and at-rule preludes are skipped.
 */
function declarations(
  source: string,
): { property: string; value: string; forcedColors: boolean }[] {
  const css = source.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
  const found: { property: string; value: string; forcedColors: boolean }[] = []
  /** The preludes of the blocks around the current position. */
  const blocks: string[] = []
  let buffer = ''
  let parens = 0
  const flush = (): void => {
    const colon = buffer.indexOf(':')
    if (colon > 0)
      found.push({
        property: buffer.slice(0, colon).trim().toLowerCase(),
        value: buffer.slice(colon + 1).trim(),
        forcedColors: blocks.some((prelude) =>
          /@media[^{]*forced-colors\s*:\s*active/i.test(prelude),
        ),
      })
    buffer = ''
  }
  for (const char of css) {
    if (char === '(') parens += 1
    if (char === ')') parens = Math.max(0, parens - 1)
    if (parens === 0 && char === '{') {
      blocks.push(buffer)
      buffer = ''
    } else if (parens === 0 && (char === ';' || char === '}')) {
      flush()
      if (char === '}') blocks.pop()
    } else buffer += char
  }
  flush()
  return found
}

/** What is wrong with how a stylesheet uses tokens: literals, fallbacks, undefined names. */
function tokenProblems(source: string, defined: ReadonlySet<string>): string[] {
  const problems: string[] = []
  for (const { property, value, forcedColors } of declarations(source)) {
    if (property.startsWith('--')) continue
    const where = `${property}: ${value}`
    // Every var() is exactly var(--name): no fallback, and the name is declared in tokens.css.
    const calls = value.match(/var\s*\(/gi)?.length ?? 0
    const exact = [...value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)]
    if (calls !== exact.length) problems.push(`${where}: var() with a fallback or malformed`)
    for (const match of exact)
      if (!defined.has((match[1] as string).toLowerCase()))
        problems.push(`${where}: ${match[1] as string} is not defined in tokens.css`)
    // Everything else must not be a literal colour.
    const rest = value
      .replace(/var\(\s*--[a-z0-9-]+\s*\)/gi, ' ')
      .replace(/url\([^)]*\)|'[^']*'|"[^"]*"/gi, ' ')
    if (/#[0-9a-f]{3,8}\b/i.test(rest)) problems.push(`${where}: hex colour literal`)
    if (COLOR_FUNCTIONS.test(rest)) problems.push(`${where}: colour function literal`)
    // Whole keywords: `background-color` in a transition list is not the `Background` colour.
    for (const word of rest.toLowerCase().match(/[a-z][a-z-]*/g) ?? []) {
      if (NAMED_COLORS.has(word)) problems.push(`${where}: named colour ${word}`)
      if (SYSTEM_COLORS.has(word) && !forcedColors)
        problems.push(`${where}: system colour ${word} outside @media (forced-colors: active)`)
    }
    // Every border-radius part is a --radius-* token (shorthand included).
    if (/^border(?:-[a-z]+)*-radius$/.test(property)) {
      const parts = value.split(/\s*\/\s*|\s+(?![^(]*\))/).filter(Boolean)
      for (const part of parts)
        if (!/^var\(\s*--radius-[a-z0-9-]+\s*\)$/i.test(part))
          problems.push(`${where}: ${part} is not a --radius token`)
    }
  }
  return problems
}

describe('stylesheets use tokens', () => {
  const sheets = import.meta.glob<string>(['./base.css', './components.css', './files.css'], {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  it.each(Object.entries(sheets))('%s only uses defined tokens, with no literals', (_file, css) => {
    // The scanner really read declarations (a parse failure must not look like a pass).
    expect(declarations(css).length).toBeGreaterThan(20)
    expect(tokenProblems(css, DEFINED)).toEqual([])
  })

  it('knows the tokens it checks against', () => {
    expect(DEFINED).toContain('--radius-xs')
    expect(DEFINED).toContain('--color-text')
  })

  it.each([
    ['a radius literal', 'a { border-radius: 3px; }'],
    ['a radius fallback', 'a { border-radius: var(--radius-xs, 3px); }'],
    ['an undefined radius token', 'a { border-radius: var(--radius-not-defined); }'],
    ['a literal in a radius shorthand', 'a { border-radius: var(--radius-sm) 4px; }'],
    ['a non-radius token as a radius', 'a { border-radius: var(--space-2); }'],
    ['a colour fallback', 'a { color: var(--color-text, #000000); }'],
    ['an empty-fallback var', 'a { color: var(--color-text,); }'],
    ['an undefined colour token', 'a { color: var(--color-missing); }'],
    ['a hex colour', 'a { color: #fff; }'],
    ['an rgb colour', 'a { color: rgb(0 0 0); }'],
    ['an uppercase RGB colour', 'a { color: RGBA(0 0 0 / 50%); }'],
    ['an uppercase VAR() with a literal fallback', 'a { color: VAR(--color-text, red); }'],
    ['a spaced var() with a fallback', 'a { color: var( --color-text , #fff ); }'],
    ['an uppercase BORDER-RADIUS literal', 'a { BORDER-RADIUS: 3px; }'],
    ['an uppercase longhand radius literal', 'a { Border-Top-Left-Radius: 3px; }'],
    ['a named colour', 'a { color: red; }'],
    ['a system colour', 'a { color: CanvasText; }'],
    ['a lowercase system colour', 'a { background: buttonface; }'],
    ['a deprecated system colour', 'a { color: WindowText; }'],
    [
      'a system colour in a non-forced-colors media block',
      '@media (min-width: 1px) { a { color: LinkText; } }',
    ],
    [
      'a system colour in a light-only forced-colors query',
      '@media (forced-colors: none) { a { color: Canvas; } }',
    ],
    ['a named colour in a shorthand', 'a { border: 1px solid White; }'],
    ['a named colour after a comment', 'a { color: /* var(--color-text) */ red; }'],
    ['an oklch() colour', 'a { color: oklch(60% 0.2 250); }'],
    [
      'a color-mix() colour',
      'a { color: color-mix(in srgb, var(--color-text) 50%, var(--color-accent)); }',
    ],
    ['a color() colour', 'a { background: color(display-p3 1 0 0); }'],
    ['an hwb() colour', 'a { color: HWB(200 10% 10%); }'],
    ['a literal inside a nested rule', '@media (min-width: 1px) { a { color: #fff; } }'],
  ])('rejects %s', (_name, css) => {
    expect(tokenProblems(css, DEFINED)).not.toEqual([])
  })

  it('accepts allowed keywords, comments and token-only values', () => {
    expect(
      tokenProblems(
        `/* red, #fff and var(--nope, 1px) in a comment are ignored */
        a { color: currentColor; background: transparent; border: none; outline: 2px solid VAR(--color-focus-ring);
            white-space: pre-wrap; color: inherit; }
        #root > a:hover { color: var(--color-text); }`,
        DEFINED,
      ),
    ).toEqual([])
  })

  it('allows system colours inside @media (forced-colors: active), at any depth', () => {
    expect(
      tokenProblems(
        `@media (forced-colors: active) {
          .unsafe-char { background: Highlight; color: HighlightText; }
          :focus-visible { outline-color: CanvasText; }
        }
        @media screen and (FORCED-COLORS : ACTIVE) { @supports (color: red) { a { color: LinkText; } } }
        a { color: var(--color-text); }`,
        DEFINED,
      ),
    ).toEqual([])
    // ...but only there: the same rule after the block is rejected again.
    expect(
      tokenProblems(
        '@media (forced-colors: active) { a { color: Canvas; } } b { color: Canvas; }',
        DEFINED,
      ),
    ).not.toEqual([])
  })

  it('accepts a radius shorthand made only of defined tokens', () => {
    expect(
      tokenProblems(
        'a { border-radius: var(--radius-lg) var(--radius-lg) var(--radius-xs) var(--radius-lg); color: var(--color-text); }',
        DEFINED,
      ),
    ).toEqual([])
  })
})
