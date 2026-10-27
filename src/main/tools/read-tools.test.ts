import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fakeContext,
  makeSandbox,
  put,
  trySymlink,
  type Sandbox,
} from '../permissions/test-support'
import { DEFAULT_LIMITS } from './deps'
import { MAX_SKIPPED_LISTED, queryTerms, safeRel } from './search-files'
import { toolHarness, type ToolHarness } from './test-support'

let sb: Sandbox
let h: ToolHarness

beforeEach(async () => {
  sb = await makeSandbox()
  h = toolHarness(sb)
})

afterEach(async () => {
  await sb.cleanup()
})

const run = (tool: string, input: unknown) => h.tool(tool).execute(input, fakeContext().ctx)

describe('list_dir', () => {
  it('lists entries with type, size and mtime, hiding protected ones', async () => {
    await put(path.join(sb.root, 'a.txt'), 'hello')
    await put(path.join(sb.root, 'sub', 'b.md'), 'x')
    await put(path.join(sb.root, '.env'), 'SECRET=1')
    await put(path.join(sb.root, 'key.pem'), 'k')
    const r = await run('list_dir', { path: sb.root })
    expect(r.isError).toBeUndefined()
    const lines = r.content.split('\n')
    expect(lines[0]).toBe(`${sb.root} (2 entries)`)
    expect(lines[1]).toMatch(/^file\s+5 B\s+\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\s+a\.txt$/)
    expect(lines[2]).toMatch(/^dir\s+-\s+.*\ssub\/$/)
    expect(r.content).toContain('2 protected entries hidden.')
    expect(r.content).not.toContain('.env')
    expect(r.content).not.toContain('key.pem')
    expect(r.content).not.toContain('b.md')
  })

  it('recurses to the requested depth', async () => {
    await put(path.join(sb.root, 'a', 'b', 'c', 'deep.txt'))
    const shallow = await run('list_dir', { path: sb.root, depth: 2 })
    expect(shallow.content).toContain('a/b/')
    expect(shallow.content).not.toContain('a/b/c/')
    const deep = await run('list_dir', { path: sb.root, depth: 4 })
    expect(deep.content).toContain('a/b/c/deep.txt')
  })

  it('caps the number of entries', async () => {
    h = toolHarness(sb, { limits: { maxListEntries: 3 } })
    for (let i = 0; i < 5; i++) await put(path.join(sb.root, `f${String(i)}.txt`))
    const r = await run('list_dir', { path: sb.root })
    expect(r.content.split('\n').filter((l) => l.startsWith('file'))).toHaveLength(3)
    expect(r.content).toContain('Stopped at 3 entries')
  })

  it('lists links without following them', async () => {
    await put(path.join(sb.outside, 'secret.txt'))
    expect(await trySymlink(sb.outside, path.join(sb.root, 'out'), 'dir')).toBe(true)
    const r = await run('list_dir', { path: sb.root, depth: 3 })
    expect(r.content).toMatch(/symlink .* out$/m)
    expect(r.content).not.toContain('secret.txt')
  })

  it('refuses folders outside the grants and bad input', async () => {
    expect(await run('list_dir', { path: sb.outside })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Access denied/) as unknown,
    })
    expect(await run('list_dir', { path: path.join(sb.root, 'missing') })).toMatchObject({
      isError: true,
    })
    expect(await run('list_dir', { path: sb.root, depth: 99 })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Invalid input/) as unknown,
    })
    expect(await run('list_dir', {})).toMatchObject({
      isError: true,
      content: expect.stringMatching(/"path" is required/) as unknown,
    })
    expect(await run('list_dir', { path: sb.root, extra: 1 })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/unknown property/) as unknown,
    })
    expect(await run('list_dir', 'nope')).toMatchObject({ isError: true })
  })
})

describe('read_file', () => {
  it('returns a header and the text', async () => {
    await put(path.join(sb.root, 'a.txt'), 'one\ntwo\nthree\n')
    const r = await run('read_file', { path: path.join(sb.root, 'a.txt') })
    expect(r).toEqual({
      content: `[${path.join(sb.root, 'a.txt')} | 14 B | 3 lines]\none\ntwo\nthree\n`,
    })
  })

  it('returns a line range', async () => {
    await put(path.join(sb.root, 'a.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\n')
    const r = await run('read_file', {
      path: path.join(sb.root, 'a.txt'),
      startLine: 2,
      endLine: 3,
    })
    expect(r.content).toMatch(/\| lines 2-3\]\ntwo\nthree$/)
    const tail = await run('read_file', { path: path.join(sb.root, 'a.txt'), startLine: 4 })
    expect(tail.content).toMatch(/lines 4-4\]\nfour$/)
    const past = await run('read_file', { path: path.join(sb.root, 'a.txt'), startLine: 10 })
    expect(past.content).toMatch(/no line 10/)
    expect(
      await run('read_file', { path: path.join(sb.root, 'a.txt'), startLine: 3, endLine: 2 }),
    ).toMatchObject({ isError: true, content: expect.stringMatching(/endLine/) as unknown })
  })

  it('decodes UTF-16 files', async () => {
    await put(
      path.join(sb.root, 'ps.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo\n', 'utf16le')]),
    )
    const r = await run('read_file', { path: path.join(sb.root, 'ps.txt') })
    expect(r.content).toMatch(/utf-16le\]\nhéllo\n$/)
  })

  it('refuses binary files', async () => {
    await put(path.join(sb.root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
    expect(await run('read_file', { path: path.join(sb.root, 'img.png') })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/binary/) as unknown,
    })
  })

  it('refuses files over the size cap unless a range is given, then streams it', async () => {
    h = toolHarness(sb, { limits: { maxReadBytes: 100 } })
    const big = Array.from({ length: 50 }, (_, i) => `line ${String(i + 1)}`).join('\n')
    await put(path.join(sb.root, 'big.log'), big)
    const whole = await run('read_file', { path: path.join(sb.root, 'big.log') })
    expect(whole).toMatchObject({
      isError: true,
      content: expect.stringMatching(/over the 100 B read limit/) as unknown,
    })

    const part = await run('read_file', {
      path: path.join(sb.root, 'big.log'),
      startLine: 10,
      endLine: 12,
    })
    expect(part.isError).toBeUndefined()
    expect(part.content).toMatch(/lines 10-12\]\nline 10\nline 11\nline 12$/)

    const capped = await run('read_file', { path: path.join(sb.root, 'big.log'), startLine: 1 })
    expect(capped.content).toMatch(/stopped at the 100 B limit; continue from line \d+/)
    expect(Buffer.byteLength(capped.content)).toBeLessThan(300)
  })

  it('cuts a single huge line at the byte cap instead of buffering it', async () => {
    h = toolHarness(sb, { limits: { maxReadBytes: 100 } })
    await put(path.join(sb.root, 'oneline.log'), 'x'.repeat(5 * 1024 * 1024))
    const r = await run('read_file', { path: path.join(sb.root, 'oneline.log'), startLine: 1 })
    expect(r.isError).toBeUndefined()
    expect(r.content).toMatch(/lines 1-1\]\nx{100}\n\[line 1 is cut at the 100 B limit\]$/)
  })

  it('refuses a file with other hard links, which may alias a file outside the grant', async () => {
    await put(path.join(sb.outside, 'secret.txt'), 'top secret')
    await fs.link(path.join(sb.outside, 'secret.txt'), path.join(sb.root, 'innocent.txt'))
    const r = await run('read_file', { path: path.join(sb.root, 'innocent.txt') })
    expect(r).toMatchObject({
      isError: true,
      content: expect.stringMatching(
        /other hard links.*another name.*copy it into a granted folder/s,
      ) as unknown,
    })
    expect(r.content).not.toContain('top secret')
    expect(h.audit.entries[0]).toMatchObject({ outcome: 'error', error: 'hard-link' })
  })

  it('refuses blocked files, folders and paths outside the grants', async () => {
    await put(path.join(sb.root, '.env'), 'SECRET=hunter2')
    await put(path.join(sb.outside, 'x.txt'), 'x')
    const blocked = await run('read_file', { path: path.join(sb.root, '.env') })
    expect(blocked).toMatchObject({
      isError: true,
      content: expect.stringMatching(/blocked/) as unknown,
    })
    expect(blocked.content).not.toContain('hunter2')
    expect(await run('read_file', { path: path.join(sb.outside, 'x.txt') })).toMatchObject({
      isError: true,
    })
    expect(await run('read_file', { path: sb.root })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Not a file/) as unknown,
    })
    expect(await run('read_file', { path: path.join(sb.root, 'nope.txt') })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/not found/) as unknown,
    })
  })

  it('refuses to read through a link out of the grant', async (ctx) => {
    await put(path.join(sb.outside, 'secret.txt'), 'top secret')
    if (
      !(await trySymlink(path.join(sb.outside, 'secret.txt'), path.join(sb.root, 'x.txt'), 'file'))
    )
      ctx.skip()
    const r = await run('read_file', { path: path.join(sb.root, 'x.txt') })
    expect(r).toMatchObject({
      isError: true,
      content: expect.stringMatching(/outside the granted/) as unknown,
    })
    expect(r.content).not.toContain('top secret')
  })

  it('audits the call without file contents', async () => {
    await put(path.join(sb.root, 'a.txt'), 'PRIVATE CONTENT')
    await run('read_file', { path: path.join(sb.root, 'a.txt') })
    expect(h.audit.entries).toEqual([
      expect.objectContaining({
        tool: 'read_file',
        args: { path: path.join(sb.root, 'a.txt') },
        paths: [path.join(sb.root, 'a.txt')],
        approval: 'auto',
        outcome: 'ok',
      }),
    ])
    expect(JSON.stringify(h.audit.entries)).not.toContain('PRIVATE CONTENT')
  })

  it('audits failures by category, not by message', async () => {
    await put(path.join(sb.root, '.env'), 'X=1')
    await run('read_file', { path: path.join(sb.root, '.env') })
    await run('read_file', { path: path.join(sb.root, 'missing.txt') })
    await run('read_file', { nope: true })
    expect(h.audit.entries.map((e) => e.error)).toEqual([
      'access-denied',
      'not-found',
      'invalid-input',
    ])
  })
})

describe('search_files', () => {
  beforeEach(async () => {
    await put(path.join(sb.root, 'src', 'index.ts'), 'export const answer = 42\n// TODO: tidy\n')
    await put(path.join(sb.root, 'src', 'util.ts'), 'export function todo() {}\n')
    await put(path.join(sb.root, 'docs', 'guide.md'), '# Guide\nSee the TODO list.\n')
    await put(path.join(sb.root, '.env'), 'TODO_SECRET=hunter2\n')
    await put(path.join(sb.root, 'node_modules', 'pkg', 'index.ts'), '// TODO in deps\n')
    await put(path.join(sb.root, 'bin.dat'), Buffer.from([0, 1, 2, 84, 79, 68, 79]))
  })

  it('finds files by name glob', async () => {
    const r = await run('search_files', { path: sb.root, namePattern: '*.ts' })
    expect(r.content.split('\n')).toEqual([
      `2 results in ${sb.root}`,
      'src/index.ts',
      'src/util.ts',
      '1 protected entries hidden.',
    ])
  })

  it('matches path globs against the relative path', async () => {
    const r = await run('search_files', { path: sb.root, namePattern: 'docs/**/*.md' })
    expect(r.content).toContain('docs/guide.md')
    expect(r.content).not.toContain('src/')
  })

  it('finds content case-insensitively by default, skipping blocked, binary and node_modules', async () => {
    const r = await run('search_files', { path: sb.root, contentPattern: 'todo' })
    expect(r.content).toContain('src/index.ts:2: // TODO: tidy')
    expect(r.content).toContain('src/util.ts:1: export function todo() {}')
    expect(r.content).toContain('docs/guide.md:2: See the TODO list.')
    expect(r.content).not.toContain('hunter2')
    expect(r.content).not.toContain('node_modules')
    expect(r.content).not.toContain('bin.dat:')
    expect(r.content).toContain('  bin.dat (binary, not searched)')
    const exact = await run('search_files', {
      path: sb.root,
      contentPattern: 'TODO',
      caseSensitive: true,
    })
    expect(exact.content).not.toContain('util.ts')
  })

  it('supports regexes and rejects invalid ones', async () => {
    const r = await run('search_files', {
      path: sb.root,
      contentPattern: 'answer\\s*=\\s*\\d+',
      regex: true,
    })
    expect(r.content).toContain('src/index.ts:1:')
    expect(
      await run('search_files', { path: sb.root, contentPattern: '(', regex: true }),
    ).toMatchObject({
      isError: true,
      content: expect.stringMatching(/invalid regex/) as unknown,
    })
  })

  it(
    'stops a catastrophically backtracking regex at the time cap',
    { timeout: 20_000 },
    async () => {
      h = toolHarness(sb, { limits: { searchTimeMs: 1500 } })
      await put(path.join(sb.root, 'evil.txt'), `${'a'.repeat(100)}!\n`)
      const started = Date.now()
      const r = await run('search_files', {
        path: sb.root,
        contentPattern: '(a|aa)+$',
        regex: true,
      })
      const elapsed = Date.now() - started
      expect(r.isError).toBeUndefined()
      expect(r.content).toMatch(/Search stopped early: reached the 1\.5 s time limit/)
      expect(elapsed).toBeLessThan(1500 + 2500)
    },
  )

  it('stops a catastrophic name glob at the time cap', { timeout: 20_000 }, async () => {
    h = toolHarness(sb, { limits: { searchTimeMs: 1500 } })
    await put(path.join(sb.root, 'a'.repeat(120)))
    const started = Date.now()
    const r = await run('search_files', { path: sb.root, namePattern: `${'*a'.repeat(12)}*b` })
    expect(r.content).toMatch(/time limit/)
    expect(Date.now() - started).toBeLessThan(1500 + 2500)
  })

  it('interrupts a slow regex when the call is cancelled', { timeout: 20_000 }, async () => {
    await put(path.join(sb.root, 'evil.txt'), `${'a'.repeat(100)}!\n`)
    const { ctx, controller } = fakeContext()
    setTimeout(() => {
      controller.abort()
    }, 300)
    const started = Date.now()
    const r = await h
      .tool('search_files')
      .execute({ path: sb.root, contentPattern: '(a|aa)+$', regex: true }, ctx)
    expect(r).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Cancelled/) as unknown,
    })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('lists binary files by name but never searches their content', async () => {
    const byName = await run('search_files', { path: sb.root, namePattern: '*.dat' })
    expect(byName.content).toContain('bin.dat')
    const byContent = await run('search_files', { path: sb.root, contentPattern: 'TODO' })
    expect(byContent.content).not.toContain('bin.dat:')
  })

  it('skips the content of hard-linked files', async () => {
    await fs.link(path.join(sb.root, 'docs', 'guide.md'), path.join(sb.outside, 'alias.md'))
    const r = await run('search_files', { path: sb.root, contentPattern: 'see the todo' })
    expect(r.content).toMatch(/^0 results/)
    expect(r.content).toContain('2 files skipped: 1 binary, not searched; 1 hard-linked.')
    expect(r.content).toContain('  docs/guide.md (hard-linked)')
  })

  it('combines name and content filters', async () => {
    const r = await run('search_files', {
      path: sb.root,
      namePattern: '*.md',
      contentPattern: 'todo',
    })
    expect(r.content.split('\n')).toEqual([
      `1 result in ${sb.root}`,
      'docs/guide.md:2: See the TODO list.',
      '1 protected entries hidden.',
    ])
  })

  it('stops at maxResults, the depth cap and the time cap', async () => {
    const limited = await run('search_files', {
      path: sb.root,
      contentPattern: 'todo',
      maxResults: 1,
    })
    expect(limited.content).toMatch(/^1 result/)
    expect(limited.content).toContain('reached maxResults (1)')

    const shallow = await run('search_files', { path: sb.root, namePattern: '*.ts', maxDepth: 1 })
    expect(shallow.content).toMatch(/^0 results/)

    let clock = 0
    h = toolHarness(sb, { now: () => (clock += 1000), limits: { searchTimeMs: 2500 } })
    const timed = await run('search_files', { path: sb.root, namePattern: '*' })
    expect(timed.content).toContain('time limit')
  })

  it('requires a pattern and a folder inside the grants', async () => {
    expect(await run('search_files', { path: sb.root })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/namePattern/) as unknown,
    })
    expect(await run('search_files', { path: sb.outside, namePattern: '*' })).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Access denied/) as unknown,
    })
  })

  it('stops when cancelled', async () => {
    const { ctx, controller } = fakeContext()
    controller.abort()
    const r = await h.tool('search_files').execute({ path: sb.root, namePattern: '*' }, ctx)
    expect(r).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Cancelled/) as unknown,
    })
  })

  it('logs only the kind and length of patterns, never the patterns', async () => {
    await run('search_files', { path: sb.root, namePattern: '*secret*', contentPattern: 'hunter2' })
    await run('search_files', { path: sb.root, contentPattern: 'hun+ter', regex: true })
    expect(h.audit.entries.map((e) => e.args)).toEqual([
      {
        path: sb.root,
        namePattern: { kind: 'glob', length: 8 },
        contentPattern: { kind: 'substring', length: 7 },
        caseSensitive: false,
        maxResults: 100,
        maxDepth: 20,
      },
      expect.objectContaining({ contentPattern: { kind: 'regex', length: 7 } }),
    ])
    const logged = JSON.stringify(h.audit.entries)
    expect(logged).not.toContain('hunter2')
    expect(logged).not.toContain('secret')
    expect(logged).not.toContain('hun+ter')
  })
})

describe('search_files skip report', () => {
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 0, 0, 0])])
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
  const BINARY = Buffer.from([0, 1, 2, 3])
  const search = (contentPattern: string) => run('search_files', { path: sb.root, contentPattern })
  const listed = (content: string) => content.split('\n').filter((l) => l.startsWith('  '))

  it('counts each skip reason separately, never naming protected files', async () => {
    h = toolHarness(sb, { limits: { maxReadBytes: 64 } })
    await put(path.join(sb.root, 'plan.pdf'), PDF)
    await put(path.join(sb.root, 'photo.png'), PNG)
    await put(path.join(sb.root, 'blob.dat'), BINARY)
    await put(path.join(sb.root, 'big.txt'), 'x'.repeat(65))
    await put(path.join(sb.root, 'big.xlsx'), 'x'.repeat(65))
    await put(path.join(sb.root, 'linked.txt'), 'needle')
    await fs.link(path.join(sb.root, 'linked.txt'), path.join(sb.outside, 'alias.txt'))
    await put(path.join(sb.root, '.env'), 'needle=1')
    await put(path.join(sb.root, 'key.pem'), 'needle')
    const r = await search('needle')
    expect(r.isError).toBeUndefined()
    expect(r.content).toContain(
      '6 files skipped: 2 document, not searched; 1 binary, not searched; 2 too large; 1 hard-linked.',
    )
    expect(listed(r.content)).toEqual([
      '  big.xlsx (document, too large, 65 B)',
      '  photo.png (document, not searched)',
      '  plan.pdf (document, not searched)',
      '  big.txt (too large, 65 B)',
      '  blob.dat (binary, not searched)',
      '  linked.txt (hard-linked)',
    ])
    expect(r.content).toContain('2 protected entries hidden.')
    expect(r.content).not.toContain('.env')
    expect(r.content).not.toContain('key.pem')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'counts files that cannot be opened as unreadable',
    async () => {
      const locked = path.join(sb.root, 'locked.txt')
      await put(locked, 'needle')
      await fs.chmod(locked, 0)
      try {
        const r = await search('needle')
        expect(r.content).toContain('1 files skipped: 1 unreadable.')
        expect(listed(r.content)).toEqual(['  locked.txt (unreadable)'])
      } finally {
        await fs.chmod(locked, 0o600)
      }
    },
  )

  it('names documents first, those matching the query terms before the rest', async () => {
    await put(path.join(sb.root, 'a.dat'), BINARY)
    await put(path.join(sb.root, 'b-drawing.pdf'), PDF)
    await put(path.join(sb.root, 'c', 'RFI-012 response.pdf'), PDF)
    const r = await search('rfi 012')
    expect(listed(r.content)).toEqual([
      '  c/RFI-012 response.pdf (document, not searched)',
      '  b-drawing.pdf (document, not searched)',
      '  a.dat (binary, not searched)',
    ])
  })

  it(`names at most ${String(MAX_SKIPPED_LISTED)} skipped files and counts the rest`, async () => {
    for (let i = 0; i < MAX_SKIPPED_LISTED + 10; i++) {
      await put(path.join(sb.root, `scan-${String(i).padStart(3, '0')}.pdf`), PDF)
    }
    const r = await search('needle')
    expect(r.content).toContain(`${String(MAX_SKIPPED_LISTED + 10)} files skipped:`)
    expect(listed(r.content)).toHaveLength(MAX_SKIPPED_LISTED + 1)
    expect(listed(r.content).at(-1)).toBe('  …and 10 more not listed.')
  })

  it('points to read_document only when documents were skipped', async () => {
    await put(path.join(sb.root, 'blob.dat'), BINARY)
    const binaryOnly = await search('needle')
    expect(binaryOnly.content).toContain('1 binary, not searched')
    expect(binaryOnly.content).not.toContain('read_document')
    await put(path.join(sb.root, 'report.pdf'), PDF)
    const withDocument = await search('needle')
    expect(withDocument.content).toContain(
      'PDFs, Word, Excel and PowerPoint files and images are not searched by content: open the ' +
        'likely ones above with read_document.',
    )
  })

  it('reports nothing skipped for a name-only search', async () => {
    await put(path.join(sb.root, 'report.pdf'), PDF)
    const r = await run('search_files', { path: sb.root, namePattern: '*.pdf' })
    expect(r.content.split('\n')).toEqual([`1 result in ${sb.root}`, 'report.pdf'])
  })

  it('removes control and bidi characters from listed names', async () => {
    expect(safeRel('a\u202Efdp.exe')).toBe('a\uFFFDfdp.exe')
    expect(safeRel('x\ny\u0007z\u200B.pdf')).toBe('x\uFFFDy\uFFFDz\uFFFD.pdf')
    const name = process.platform === 'win32' ? 'evil\u202Efdp.png' : 'evil\n\u202Efdp.png'
    await put(path.join(sb.root, name), PNG)
    const r = await search('needle')
    expect(r.content).not.toContain('\u202E')
    const expected = process.platform === 'win32' ? 'evil\uFFFDfdp.png' : 'evil\uFFFD\uFFFDfdp.png'
    expect(listed(r.content)).toEqual([`  ${expected} (document, not searched)`])
  })

  it('takes name terms from the pattern, regex syntax ignored', () => {
    expect(queryTerms('RFI-012 Response')).toEqual(['rfi', '012', 'response'])
    expect(queryTerms('rfi\\s*\\d+|drawing')).toEqual(['rfi', 'drawing'])
    expect(queryTerms(undefined)).toEqual([])
  })

  it('allows 30 s by default and says when the time limit made results partial', async () => {
    expect(DEFAULT_LIMITS.searchTimeMs).toBe(30_000)
    expect(toolHarness(sb).tool('search_files').description).toContain('30 s')
    await put(path.join(sb.root, 'a.txt'), 'needle')
    let clock = 0
    h = toolHarness(sb, { now: () => (clock += 20_000) })
    const r = await search('needle')
    expect(r.content).toContain(
      'Search stopped early: reached the 30 s time limit (a slow pattern is stopped there). ' +
        'Results are partial',
    )
  })
})

describe('read-only tools never mutate', () => {
  it('leave the tree unchanged', async () => {
    await put(path.join(sb.root, 'a.txt'), 'a')
    const before = await fs.readdir(sb.root)
    await run('list_dir', { path: sb.root })
    await run('read_file', { path: path.join(sb.root, 'a.txt') })
    await run('search_files', { path: sb.root, namePattern: '*' })
    expect(await fs.readdir(sb.root)).toEqual(before)
  })
})
