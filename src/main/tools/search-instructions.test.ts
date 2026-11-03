import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT } from '../agent'
import { fakeContext, makeSandbox, put, type Sandbox } from '../permissions/test-support'
import { toolHarness, type ToolHarness } from './test-support'

/**
 * The agent's search guidance quotes search_files' parameters and result wording. These
 * tests run the real tool, so neither can change without the guidance changing with it.
 */

let sb: Sandbox
let h: ToolHarness

beforeEach(async () => {
  sb = await makeSandbox()
  h = toolHarness(sb)
})

afterEach(async () => {
  await sb.cleanup()
})

const search = async (input: Record<string, unknown>): Promise<string> =>
  (await h.tool('search_files').execute({ path: sb.root, ...input }, fakeContext().ctx)).content

describe('search guidance', () => {
  it.each([
    ['terminology', 'spelling variants, synonyms and the abbreviations used in that field'],
    ['an example', '"walk-in freezer", "walk-in cooler", "WIF", "WIC"'],
    ['no wasted terms', 'already handles case, spaces, hyphens and line breaks'],
    ['broad terms', 'start with output: "files" to see where it occurs, then narrow'],
    ['continuation', 'continue with that cursor before concluding'],
    ['absence', 'never state or imply that something is not mentioned unless'],
    ['coverage', 'skipped files, scanned PDFs with no text layer'],
    ['next step', 'offer that as the next step'],
    ['hit limits', 'A limit on the matches shown says nothing about which files were checked'],
  ])('covers %s', (_topic, phrase) => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain(phrase)
  })

  it('keeps the guidance on one search at a time and on continuing with a cursor', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Run one search_files call at a time')
    // Without its cursor a call starts over: nothing may say the same arguments are enough.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain('with the same arguments to continue')
  })

  it('names only tools and search_files parameters that exist', () => {
    expect(h.tools).toHaveProperty('search_files')
    expect(h.tools).toHaveProperty('read_document')
    const { properties } = h.tool('search_files').inputSchema
    for (const parameter of ['anyOf', 'output', 'cursor']) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(parameter)
      expect(properties).toHaveProperty(parameter)
    }
    expect(properties).toHaveProperty('output.enum', expect.arrayContaining(['files']))
  })

  it('quotes the wording of a complete search, a stopped one and its continuation', async () => {
    for (let i = 0; i < 12; i++) {
      await put(path.join(sb.root, `f${String(i).padStart(2, '0')}.txt`), 'freezer\n')
    }
    expect(await search({ contentPattern: 'freezer' })).toContain('Every file was checked')

    h = toolHarness(sb, { limits: { maxSearchEntries: 5 } })
    const first = await search({ contentPattern: 'freezer' })
    expect(first).toContain('Not every file was checked')
    const cursor = /cursor: "(sf1\.[\w-]+)"\.$/m.exec(first)?.[1]
    expect(cursor).toBeDefined()

    h = toolHarness(sb)
    const rest = await search({ contentPattern: 'freezer', cursor })
    expect(rest).toContain('Every file after the cursor was checked')

    for (const wording of [
      '"Not every file"',
      '"Every file was checked"',
      '"Every file after the cursor was checked"',
    ])
      expect(DEFAULT_SYSTEM_PROMPT).toContain(wording)
    expect(h.tool('search_files').description).toContain('"Every file was checked"')
  })

  it('tells the truth about flexible matching: spaces, hyphens and line breaks', async () => {
    await put(path.join(sb.root, 'rfi.txt'), 'See the WALK-IN\nfreezer door.\n')
    const result = await search({ contentPattern: 'walk in freezer' })
    expect(result).toContain('Every file was checked: 1 match in 1 file')
  })
})
