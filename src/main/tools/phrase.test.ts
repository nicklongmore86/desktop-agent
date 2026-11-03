import { describe, expect, it } from 'vitest'
import { fold, PhraseError, PhraseMatcher, windowAround, type PhraseOptions } from './phrase'

// Unicode characters by code point, so the source stays plain ASCII.
const ch = (...codes: number[]): string => String.fromCodePoint(...codes)
const SHY = ch(0xad)
const NBSP = ch(0xa0)
const ZWSP = ch(0x200b)
const HYPHEN = ch(0x2010)
const NB_HYPHEN = ch(0x2011)
const EN_DASH = ch(0x2013)
const EM_DASH = ch(0x2014)
const MINUS = ch(0x2212)
/** "WALK" in fullwidth letters, which NFKC turns into ASCII. */
const FULLWIDTH_WALK = ch(0xff37, 0xff21, 0xff2c, 0xff2b)

const control = { timeLeft: () => 60_000, signal: new AbortController().signal }

async function hits(
  lines: string[],
  terms: string[],
  options: Partial<Omit<PhraseOptions, 'terms'>> & { joinable?: (i: number) => boolean } = {},
): Promise<{ line: number; terms: number[] }[]> {
  const matcher = new PhraseMatcher({
    terms,
    exact: options.exact ?? false,
    caseSensitive: options.caseSensitive ?? false,
  })
  const found = await matcher.match(lines, 1000, { ...control, joinable: options.joinable })
  if (typeof found === 'string') throw new Error(found)
  return found
}

const matchedLines = async (
  lines: string[],
  term: string,
  options: Parameters<typeof hits>[2] = {},
): Promise<number[]> => (await hits(lines, [term], options)).map((h) => h.line)

describe('flexible phrase matching', () => {
  it.each([
    ['Walk-In Freezer', 'walk in freezer'],
    ['WALK-IN FREEZER', 'walk in freezer'],
    ['walkin freezer', 'walk in freezer'],
    ['Walk  In   Freezer', 'walk in freezer'],
    [`Walk${NBSP}In Freezer`, 'walk in freezer'],
    ['walk_in/freezer', 'walk in freezer'],
    [`walk ${EM_DASH} in freezer`, 'walk in freezer'],
    [`Walk${HYPHEN}In`, 'walk in'],
    [`Walk${NB_HYPHEN}In`, 'walk in'],
    [`Walk${EN_DASH}In`, 'walk in'],
    [`Walk${MINUS}In`, 'walk in'],
    [`Walk${SHY}In Freezer`, 'walk in freezer'],
    [`Walk${ZWSP}In`, 'walkin'],
    [`${FULLWIDTH_WALK}-IN`, 'walk in'],
    ['Walk-In', 'walk-in'],
    ['Walk In', 'Walk-In'],
    ['STRASSE 5', `stra${ch(0xdf)}e`],
    ['refrigerator', 'refrigerator'],
  ])('finds %j for %j', async (text, term) => {
    expect(await matchedLines(['intro', text, 'outro'], term)).toEqual([1])
  })

  it.each([
    ['walk in', 'walk-out'],
    ['walk in', 'walk. in'],
    ['walk in', `walk ${'-'.repeat(9)} in`],
    ['freezer', 'freeze'],
  ])('does not take %j for %j', async (term, text) => {
    expect(await matchedLines([text], term)).toEqual([])
  })

  it('matches across a line wrap and reports the line the match starts in', async () => {
    const lines = ['Provide one Walk-In', 'Freezer with a heated', 'threshold.', 'Walk In Freezer']
    expect(await matchedLines(lines, 'walk in freezer')).toEqual([0, 3])
    expect(await matchedLines(lines, 'heated threshold')).toEqual([1])
    // A phrase may run on over up to three more lines.
    expect(await matchedLines(['one walk', 'in', 'the', 'freezer'], 'walk in the freezer')).toEqual(
      [0],
    )
    expect(
      await matchedLines(['one walk', 'in', 'the', 'big', 'freezer'], 'walk in the big freezer'),
    ).toEqual([])
  })

  it('rejoins a word hyphenated across a line break, hard or soft', async () => {
    expect(await matchedLines(['the refrig-', 'erator door'], 'refrigerator door')).toEqual([0])
    expect(await matchedLines([`the refrig${SHY}`, 'erator door'], 'refrigerator')).toEqual([0])
    expect(await matchedLines(['the Walk-', 'In Freezer'], 'walk-in freezer')).toEqual([0])
    // Not before a number: "11-" then "40" stays two numbers.
    expect(await matchedLines(['Section 11-', '40 00'], '11 40')).toEqual([0])
  })

  it('does not match across lines that are not joinable (sheet cells, other pages)', async () => {
    const lines = ['Walk', 'In', 'Walk', 'In']
    const joinable = (i: number): boolean => i !== 1
    expect(await matchedLines(lines, 'walk in', { joinable })).toEqual([2])
    expect(await matchedLines(lines, 'walk in', { joinable: () => false })).toEqual([])
  })

  it('matches short terms and codes as whole words only', async () => {
    const lines = ['the WICKET gate', 'see WIC-2', 'a WIC.', 'swic', 'A501 detail', 'A5012']
    expect(await matchedLines(lines, 'WIC')).toEqual([1, 2])
    expect(await matchedLines(lines, 'a501')).toEqual([4])
    expect(await matchedLines(['WIF', 'WIFI', 'the wif?'], 'wif')).toEqual([0, 2])
    // Longer words still match inside others.
    expect(await matchedLines(['refreezer'], 'freezer')).toEqual([0])
    const matcher = new PhraseMatcher({
      terms: ['WIC', 'freezer'],
      exact: false,
      caseSensitive: false,
    })
    expect([matcher.wholeWord(0), matcher.wholeWord(1)]).toEqual([true, false])
  })

  it('finds any of several terms and says which matched', async () => {
    const lines = ['Walk-In Freezer', 'the WIF', 'nothing', 'WIF walk in freezer']
    expect(await hits(lines, ['walk in freezer', 'wif', 'cooler'])).toEqual([
      { line: 0, terms: [0] },
      { line: 1, terms: [1] },
      { line: 3, terms: [0, 1] },
    ])
    const matcher = new PhraseMatcher({ terms: ['a', 'b'], exact: false, caseSensitive: false })
    expect(matcher.label([0, 1], (t) => t)).toBe('(matched "a", "b") ')
    const single = new PhraseMatcher({ terms: ['a'], exact: false, caseSensitive: false })
    expect(single.label([0], (t) => t)).toBe('')
  })

  it('matches literally, line by line, with exact', async () => {
    const lines = ['Walk-In Freezer', 'walk in freezer', 'WICKET', 'walk-', 'in']
    expect(await matchedLines(lines, 'walk in', { exact: true })).toEqual([1])
    expect(await matchedLines(lines, 'WIC', { exact: true })).toEqual([2])
    expect(await matchedLines(lines, 'walk-in', { exact: true })).toEqual([0])
    expect(await matchedLines(lines, 'Walk', { exact: true, caseSensitive: true })).toEqual([0])
  })

  it('folds case only without caseSensitive', async () => {
    expect(await matchedLines(['Walk-In'], 'walk in', { caseSensitive: true })).toEqual([])
    expect(await matchedLines(['Walk-In'], 'Walk In', { caseSensitive: true })).toEqual([0])
  })

  it('looks for a term with no words as typed, and refuses an empty one', async () => {
    expect(await matchedLines(['a - b', 'ab'], ' - ')).toEqual([0])
    expect(() => new PhraseMatcher({ terms: ['  '], exact: false, caseSensitive: false })).toThrow(
      PhraseError,
    )
  })

  it('treats regex syntax in a term as text', async () => {
    expect(await matchedLines(['cost (a+b)*2', 'aab2'], '(a+b)*2')).toEqual([0])
    expect(await matchedLines(['x.y', 'xzy'], 'x.y')).toEqual([0])
  })

  it('returns the first matching lines up to the room given, across blocks', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => (i % 100 === 99 ? 'walk-in' : 'nope'))
    const matcher = new PhraseMatcher({ terms: ['walk in'], exact: false, caseSensitive: false })
    const found = await matcher.match(lines, 3, control)
    expect(found).toEqual([
      { line: 99, terms: [0] },
      { line: 199, terms: [0] },
      { line: 299, terms: [0] },
    ])
    // A match across the boundary between two blocks of lines.
    const edge = Array.from({ length: 600 }, () => 'x')
    edge[255] = 'the walk'
    edge[256] = 'in freezer'
    expect(await matchedLines(edge, 'walk in freezer')).toEqual([255])
  })

  it('stays fast on adversarial input (no catastrophic backtracking)', async () => {
    // Every start position matches most of the term before failing at its end.
    const term = `${'a '.repeat(99)}b`
    const lines = Array.from({ length: 250 }, () => 'a'.repeat(4000))
    const started = Date.now()
    expect(await matchedLines(lines, term)).toEqual([])
    const separators = Array.from({ length: 250 }, () => `${'a-'.repeat(1999)}a`)
    expect(await matchedLines(separators, term)).toEqual([])
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('stops for the deadline or a cancel during a long scan', async () => {
    const lines = Array.from({ length: 200_000 }, () => `${'x'.repeat(200)} no match`)
    const matcher = new PhraseMatcher({ terms: ['walk in'], exact: false, caseSensitive: false })
    let calls = 0
    const timed = await matcher.match(lines, 10, {
      timeLeft: () => (++calls > 1 ? 0 : 1000),
      signal: control.signal,
    })
    expect(timed).toBe('time')
    const abort = new AbortController()
    abort.abort()
    expect(await matcher.match(lines, 10, { timeLeft: () => 1000, signal: abort.signal })).toBe(
      'cancelled',
    )
  })
})

describe('case folding', () => {
  const LONG_S = ch(0x17f)
  const KELVIN = ch(0x212a)
  const ANGSTROM = ch(0x212b)
  const A_RING = ch(0xe5)
  const SHARP_S = ch(0xdf)
  const CAPITAL_SHARP_S = ch(0x1e9e)
  const FI = ch(0xfb01)
  const SIGMA = ch(0x3c3)
  const FINAL_SIGMA = ch(0x3c2)
  const CAPITAL_SIGMA = ch(0x3a3)

  it.each([
    [`${LONG_S}ection`, 'section'],
    [`MAS${LONG_S}`, 'mass'],
    [`300 ${KELVIN}`, '300 k'],
    [`5 ${ANGSTROM}`, `5 ${A_RING}`],
    [`STRA${CAPITAL_SHARP_S}E`, 'strasse'],
    [`STRA${CAPITAL_SHARP_S}E`, `stra${SHARP_S}e`],
    [`Stra${SHARP_S}e`, `STRA${CAPITAL_SHARP_S}E`],
    [`${FI}nish`, 'finish'],
    [`${FI}nish`, 'FINISH'],
    [
      `ODY${CAPITAL_SIGMA}${CAPITAL_SIGMA}EY${CAPITAL_SIGMA}`,
      `ody${SIGMA}${SIGMA}ey${FINAL_SIGMA}`,
    ],
    [
      `ody${SIGMA}${SIGMA}ey${FINAL_SIGMA}`,
      `ODY${CAPITAL_SIGMA}${CAPITAL_SIGMA}EY${CAPITAL_SIGMA}`,
    ],
    [`${CAPITAL_SIGMA}${FINAL_SIGMA}`, `${SIGMA}${SIGMA}`],
  ])('folds %j together with %j', async (text, term) => {
    expect(fold(text, false)).toBe(fold(term, false))
    expect(await matchedLines(['intro', text], term)).toEqual([1])
  })

  it('has no locale rules for i', () => {
    expect(fold(ch(0x131), false)).toBe('i')
    expect(fold(ch(0x130), false)).toBe(`i${ch(0x307)}`)
  })

  it('keeps case with caseSensitive, folding only NFKC', () => {
    expect(fold(`${FI}nish ${KELVIN}`, true)).toBe('finish K')
    expect(fold(`STRA${CAPITAL_SHARP_S}E`, true)).toBe(`STRA${CAPITAL_SHARP_S}E`)
  })

  it('maps lines correctly after folds that change length', async () => {
    // Each line grows when folded (ss, fi, an astral character); the hit must stay on its line.
    const astral = ch(0x1d400) // MATHEMATICAL BOLD CAPITAL A, NFKC "A"
    const lines = [
      `${CAPITAL_SHARP_S.repeat(50)} ${FI.repeat(50)}`,
      `${astral.repeat(30)} walk`,
      `in freezer ${SHARP_S.repeat(40)}`,
      `${FI.repeat(10)} Walk-In Freezer`,
    ]
    expect(await matchedLines(lines, 'walk in freezer')).toEqual([1, 3])
    expect(await matchedLines(lines, 'aaa walk')).toEqual([1])
  })

  it('cuts snippets around the match after folds that change length', () => {
    const matcher = new PhraseMatcher({ terms: ['walk in'], exact: false, caseSensitive: false })
    for (const filler of [CAPITAL_SHARP_S, SHARP_S, FI, ch(0x1d400), LONG_S]) {
      const text = `${filler.repeat(150)} Walk-In ${'z'.repeat(150)}`
      const shown = matcher.snippet(text, 40, [0])
      expect(shown).toContain('Walk-In')
      expect(shown.length).toBeLessThanOrEqual(40)
    }
    const after = new PhraseMatcher({ terms: ['strasse'], exact: false, caseSensitive: false })
    const text = `${FI.repeat(150)} STRA${CAPITAL_SHARP_S}E ${'z'.repeat(150)}`
    expect(after.snippet(text, 40, [0])).toContain(`STRA${CAPITAL_SHARP_S}E`)
  })
})

describe('fold and snippets', () => {
  it('folds NFKC, case, invisible characters and white space', () => {
    expect(fold(`  ${FULLWIDTH_WALK}${SHY}IN\t\t Freezer `, false)).toBe('walkin freezer')
    expect(fold(`${ch(0xfb01)}re`, false)).toBe('fire')
  })

  it('cuts a long line around the match, or at its end for a match running on', () => {
    const matcher = new PhraseMatcher({ terms: ['walk in'], exact: false, caseSensitive: false })
    const long = `${'y'.repeat(300)} Walk-In ${'z'.repeat(300)}`
    const shown = matcher.snippet(long, 50, [0])
    expect(shown).toContain('Walk-In')
    expect(shown.length).toBeLessThanOrEqual(50)
    const runsOn = `${'y'.repeat(300)} walk`
    expect(matcher.snippet(runsOn, 50, [0]).endsWith('walk')).toBe(true)
    expect(windowAround('short', 0, 1, 50)).toBe('short')
  })
})
