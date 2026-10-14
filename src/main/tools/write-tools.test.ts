import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  exists,
  fakeContext,
  makeSandbox,
  put,
  trySymlink,
  windowsShortPath,
  type Sandbox,
} from '../permissions/test-support'
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

/** Every file under `dir` with its content, for before/after comparisons. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name)
    const rel = path.relative(dir, full)
    out[rel] = entry.isFile()
      ? await fs.readFile(full, 'utf8')
      : `<${entry.isDirectory() ? 'dir' : 'link'}>`
  }
  return out
}

describe('write_file', () => {
  it('creates a file after approval, showing the whole content as a diff', async () => {
    const { ctx, requests } = fakeContext(true)
    const file = path.join(sb.root, 'new', 'hello.txt')
    const r = await h.tool('write_file').execute({ path: file, content: 'hello\nworld\n' }, ctx)
    expect(r).toEqual({ content: `Created ${file} (12 B).` })
    expect(await fs.readFile(file, 'utf8')).toBe('hello\nworld\n')
    expect(requests).toEqual([
      {
        tool: 'write_file',
        kind: 'write',
        summary: `Create ${file} (+2 -0 lines)`,
        detail: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,2 @@\n+hello\n+world\n`,
      },
    ])
    expect(h.audit.entries[0]).toMatchObject({
      tool: 'write_file',
      approval: 'approved',
      outcome: 'ok',
    })
  })

  it('overwrites with a unified diff of the change', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'one\ntwo\nthree\n')
    const { ctx, requests } = fakeContext(true)
    await h.tool('write_file').execute({ path: file, content: 'one\n2\nthree\n' }, ctx)
    expect(requests[0]?.summary).toBe(`Edit ${file} (+1 -1 lines)`)
    expect(requests[0]?.detail).toContain('-two\n+2\n')
    expect(await fs.readFile(file, 'utf8')).toBe('one\n2\nthree\n')
  })

  it('changes nothing when the user declines', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'original\n')
    const before = await snapshot(sb.root)
    const { ctx } = fakeContext(false)
    const edit = await h.tool('write_file').execute({ path: file, content: 'changed\n' }, ctx)
    const create = await h
      .tool('write_file')
      .execute({ path: path.join(sb.root, 'newdir', 'b.txt'), content: 'x' }, ctx)
    expect(edit).toMatchObject({ isError: true, content: /declined/ })
    expect(create).toMatchObject({ isError: true, content: /declined/ })
    expect(await snapshot(sb.root)).toEqual(before)
    expect(h.audit.entries.map((e) => e.approval)).toEqual(['denied', 'denied'])
  })

  it('treats a failing approval prompt as a refusal', async () => {
    const file = path.join(sb.root, 'a.txt')
    const { ctx } = fakeContext(() => {
      throw new Error('window closed')
    })
    expect(await h.tool('write_file').execute({ path: file, content: 'x' }, ctx)).toMatchObject({
      isError: true,
    })
    expect(await exists(file)).toBe(false)
  })

  it('does not write if cancelled while waiting for approval', async () => {
    const file = path.join(sb.root, 'a.txt')
    const { ctx, controller } = fakeContext(() => {
      controller.abort()
      return true
    })
    expect(await h.tool('write_file').execute({ path: file, content: 'x' }, ctx)).toMatchObject({
      isError: true,
    })
    expect(await exists(file)).toBe(false)
  })

  it('never asks for blocked or outside paths', async () => {
    const { ctx, requests } = fakeContext(true)
    for (const target of [
      path.join(sb.root, '.env'),
      path.join(sb.root, 'certs', 'server.key'),
      path.join(sb.root, '.ssh', 'authorized_keys'),
      path.join(sb.outside, 'x.txt'),
      path.join(sb.root, '..', 'outside', 'y.txt'),
      path.join(sb.userData, 'grants.json'),
    ]) {
      const r = await h.tool('write_file').execute({ path: target, content: 'pwned' }, ctx)
      expect(r, target).toMatchObject({ isError: true, content: /Access denied/ })
    }
    expect(requests).toEqual([])
    expect(await snapshot(sb.outside)).toEqual({})
    expect(await snapshot(sb.root)).toEqual({})
  })

  it('refuses to write through a folder link out of the grant', async () => {
    expect(await trySymlink(sb.outside, path.join(sb.root, 'out'), 'dir')).toBe(true)
    const { ctx, requests } = fakeContext(true)
    const r = await h
      .tool('write_file')
      .execute({ path: path.join(sb.root, 'out', 'x.txt'), content: 'x' }, ctx)
    expect(r).toMatchObject({ isError: true, content: /outside the granted/ })
    expect(requests).toEqual([])
    expect(await exists(path.join(sb.outside, 'x.txt'))).toBe(false)
  })

  it('refuses to write through a dangling link', async (ctx) => {
    const link = path.join(sb.root, 'dangling.txt')
    if (!(await trySymlink(path.join(sb.outside, 'planted.txt'), link, 'file'))) ctx.skip()
    const r = await h
      .tool('write_file')
      .execute({ path: link, content: 'x' }, fakeContext(true).ctx)
    expect(r).toMatchObject({ isError: true, content: /target does not exist/ })
    expect(await exists(path.join(sb.outside, 'planted.txt'))).toBe(false)
  })

  it('keeps CRLF line endings when replacing a CRLF file', async () => {
    const file = path.join(sb.root, 'win.txt')
    await put(file, 'a\r\nb\r\n')
    const { ctx, requests } = fakeContext(true)
    await h.tool('write_file').execute({ path: file, content: 'a\nc\n' }, ctx)
    expect(await fs.readFile(file, 'utf8')).toBe('a\r\nc\r\n')
    expect(requests[0]?.summary).toContain('+1 -1')
  })

  it('reports no change without asking', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'same\n')
    const { ctx, requests } = fakeContext(true)
    expect(await h.tool('write_file').execute({ path: file, content: 'same\n' }, ctx)).toEqual({
      content: `No change: ${file} already has this content.`,
    })
    expect(requests).toEqual([])
  })

  it('previews binary or large existing files without their content', async () => {
    const file = path.join(sb.root, 'data.bin')
    await put(file, Buffer.from([0, 1, 2, 3]))
    const { ctx, requests } = fakeContext(false)
    await h.tool('write_file').execute({ path: file, content: 'text' }, ctx)
    expect(requests[0]?.summary).toMatch(/existing file is binary/)
  })

  it('caps the content size', async () => {
    h = toolHarness(sb, { limits: { maxWriteBytes: 10 } })
    const { ctx, requests } = fakeContext(true)
    expect(
      await h
        .tool('write_file')
        .execute({ path: path.join(sb.root, 'big'), content: 'x'.repeat(11) }, ctx),
    ).toMatchObject({ isError: true, content: /write limit/ })
    expect(requests).toEqual([])
  })

  it('always shows the complete diff, and refuses writes whose diff is too big to review', async () => {
    const big = Array.from({ length: 30_000 }, (_, i) => `line ${String(i)}`).join('\n')
    const { ctx, requests } = fakeContext(true)
    const file = path.join(sb.root, 'big.txt')
    const r = await h.tool('write_file').execute({ path: file, content: big }, ctx)
    expect(r).toMatchObject({
      isError: true,
      content: /over the 256\.0 KB the user can review.*smaller edits/s,
    })
    expect(requests).toEqual([])
    expect(await exists(file)).toBe(false)
    expect(h.audit.entries[0]).toMatchObject({ error: 'too-large' })

    // Under the cap, every line of the payload is in the preview.
    const medium = Array.from({ length: 5000 }, (_, i) => `row ${String(i)}`).join('\n')
    await h.tool('write_file').execute({ path: file, content: medium }, ctx)
    const detail = requests[0]?.detail ?? ''
    expect(detail).not.toMatch(/truncated/)
    expect(detail).toContain('+row 0\n')
    expect(detail).toContain('+row 4999')
    expect(await fs.readFile(file, 'utf8')).toBe(medium)
  })

  it('refuses the write if the file was modified while the user was reviewing', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'original\n')
    const { ctx } = fakeContext(async () => {
      await fs.writeFile(file, 'edited by someone else\n')
      return true
    })
    const r = await h.tool('write_file').execute({ path: file, content: 'mine\n' }, ctx)
    expect(r).toMatchObject({ isError: true, content: /changed after the diff was shown/ })
    expect(await fs.readFile(file, 'utf8')).toBe('edited by someone else\n')
    expect(h.audit.entries[0]).toMatchObject({ approval: 'approved', error: 'changed' })
  })

  it('refuses the write if the file was replaced with identical bytes while reviewing', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'same\n')
    const { ctx } = fakeContext(async () => {
      await fs.rename(file, path.join(sb.root, 'a.old'))
      await put(file, 'same\n')
      return true
    })
    const r = await h.tool('write_file').execute({ path: file, content: 'new\n' }, ctx)
    expect(r).toMatchObject({ isError: true, content: /changed/ })
    expect(await fs.readFile(file, 'utf8')).toBe('same\n')
  })

  it('refuses to create a file that appeared while the user was reviewing', async () => {
    const file = path.join(sb.root, 'new.txt')
    const { ctx } = fakeContext(async () => {
      await put(file, 'someone else\n')
      return true
    })
    const r = await h.tool('write_file').execute({ path: file, content: 'mine\n' }, ctx)
    expect(r).toMatchObject({ isError: true, content: /changed after the diff was shown/ })
    expect(await fs.readFile(file, 'utf8')).toBe('someone else\n')
  })

  it('refuses the write if the file was deleted while the user was reviewing', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'original\n')
    const { ctx } = fakeContext(async () => {
      await fs.rm(file)
      return true
    })
    const r = await h.tool('write_file').execute({ path: file, content: 'mine\n' }, ctx)
    expect(r).toMatchObject({ isError: true, content: /changed/ })
    expect(await exists(file)).toBe(false)
  })

  it('refuses to overwrite (or even preview) a hard-linked file', async () => {
    await put(path.join(sb.outside, 'target.txt'), 'outside content')
    await fs.link(path.join(sb.outside, 'target.txt'), path.join(sb.root, 'alias.txt'))
    const { ctx, requests } = fakeContext(true)
    const r = await h
      .tool('write_file')
      .execute({ path: path.join(sb.root, 'alias.txt'), content: 'pwned' }, ctx)
    expect(r).toMatchObject({ isError: true, content: /other hard links/ })
    expect(requests).toEqual([])
    expect(await fs.readFile(path.join(sb.outside, 'target.txt'), 'utf8')).toBe('outside content')
  })

  it('refuses to replace a folder', async () => {
    await fs.mkdir(path.join(sb.root, 'dir'))
    expect(
      await h
        .tool('write_file')
        .execute({ path: path.join(sb.root, 'dir'), content: 'x' }, fakeContext().ctx),
    ).toMatchObject({ isError: true, content: /is a folder/ })
  })

  it('never logs the content', async () => {
    await h
      .tool('write_file')
      .execute(
        { path: path.join(sb.root, 'a.txt'), content: 'TOP SECRET CONTENT' },
        fakeContext(true).ctx,
      )
    expect(JSON.stringify(h.audit.entries)).not.toContain('TOP SECRET')
    expect(h.audit.entries[0]?.args).toEqual({ path: path.join(sb.root, 'a.txt'), bytes: 18 })
  })
})

describe('move_file', () => {
  it('moves a file after approval', async () => {
    await put(path.join(sb.root, 'a.txt'), 'A')
    const { ctx, requests } = fakeContext(true)
    const from = path.join(sb.root, 'a.txt')
    const to = path.join(sb.root, 'sub', 'b.txt')
    const r = await h.tool('move_file').execute({ source: from, destination: to }, ctx)
    expect(r).toEqual({ content: `Moved ${from} to ${to}.` })
    expect(await fs.readFile(to, 'utf8')).toBe('A')
    expect(await exists(from)).toBe(false)
    expect(requests[0]).toMatchObject({
      tool: 'move_file',
      kind: 'move',
      summary: `Move ${from} to ${to}`,
    })
  })

  it('changes nothing when declined', async () => {
    await put(path.join(sb.root, 'a.txt'), 'A')
    const before = await snapshot(sb.root)
    const r = await h
      .tool('move_file')
      .execute(
        { source: path.join(sb.root, 'a.txt'), destination: path.join(sb.root, 'b.txt') },
        fakeContext(false).ctx,
      )
    expect(r).toMatchObject({ isError: true, content: /declined/ })
    expect(await snapshot(sb.root)).toEqual(before)
  })

  it('refuses to overwrite unless asked, and only file over file', async () => {
    await put(path.join(sb.root, 'a.txt'), 'A')
    await put(path.join(sb.root, 'b.txt'), 'B')
    await fs.mkdir(path.join(sb.root, 'dir'))
    const move = (source: string, destination: string, overwrite?: boolean) =>
      h.tool('move_file').execute(
        {
          source: path.join(sb.root, source),
          destination: path.join(sb.root, destination),
          ...(overwrite === undefined ? {} : { overwrite }),
        },
        fakeContext(true).ctx,
      )
    expect(await move('a.txt', 'b.txt')).toMatchObject({ isError: true, content: /already exists/ })
    expect(await move('a.txt', 'dir', true)).toMatchObject({
      isError: true,
      content: /file with a file/,
    })
    expect(await move('a.txt', 'b.txt', true)).toMatchObject({ content: /^Moved/ })
    expect(await fs.readFile(path.join(sb.root, 'b.txt'), 'utf8')).toBe('A')
  })

  it('refuses moves out of the grant, into blocked names, or of the grant itself', async () => {
    await put(path.join(sb.root, 'a.txt'), 'A')
    await put(path.join(sb.root, '.env'), 'S')
    const { ctx, requests } = fakeContext(true)
    const move = (source: string, destination: string) =>
      h.tool('move_file').execute({ source, destination }, ctx)
    expect(await move(path.join(sb.root, 'a.txt'), path.join(sb.outside, 'a.txt'))).toMatchObject({
      isError: true,
    })
    expect(await move(path.join(sb.root, 'a.txt'), path.join(sb.root, 'id_rsa'))).toMatchObject({
      isError: true,
    })
    expect(await move(path.join(sb.root, '.env'), path.join(sb.root, 'env.txt'))).toMatchObject({
      isError: true,
    })
    expect(await move(sb.root, path.join(sb.root, 'x'))).toMatchObject({ isError: true })
    expect(requests).toEqual([])
    expect(await snapshot(sb.root)).toEqual({ 'a.txt': 'A', '.env': 'S' })
  })

  it('refuses to move a folder containing protected files, or into itself', async () => {
    await put(path.join(sb.root, 'proj', '.env'), 'S')
    await put(path.join(sb.root, 'proj', 'src', 'x.ts'), 'x')
    await put(path.join(sb.root, 'clean', 'y.ts'), 'y')
    const { ctx, requests } = fakeContext(true)
    expect(
      await h
        .tool('move_file')
        .execute(
          { source: path.join(sb.root, 'proj'), destination: path.join(sb.root, 'moved') },
          ctx,
        ),
    ).toMatchObject({ isError: true, content: /protected item/ })
    expect(
      await h.tool('move_file').execute(
        {
          source: path.join(sb.root, 'clean'),
          destination: path.join(sb.root, 'clean', 'inner'),
        },
        ctx,
      ),
    ).toMatchObject({ isError: true, content: /into itself/ })
    expect(requests).toEqual([])
  })

  it('refuses to move a hard-linked file, or overwrite one', async () => {
    await put(path.join(sb.outside, 'target.txt'), 't')
    await fs.link(path.join(sb.outside, 'target.txt'), path.join(sb.root, 'alias.txt'))
    await put(path.join(sb.root, 'plain.txt'), 'p')
    const { ctx, requests } = fakeContext(true)
    const move = (source: string, destination: string) =>
      h.tool('move_file').execute(
        {
          source: path.join(sb.root, source),
          destination: path.join(sb.root, destination),
          overwrite: true,
        },
        ctx,
      )
    expect(await move('alias.txt', 'moved.txt')).toMatchObject({
      isError: true,
      content: /hard links/,
    })
    expect(await move('plain.txt', 'alias.txt')).toMatchObject({
      isError: true,
      content: /hard links/,
    })
    expect(requests).toEqual([])
  })

  it('fails closed if the folder cannot be fully checked after approval', async () => {
    await put(path.join(sb.root, 'proj', 'sub', 'a.txt'), 'a')
    const realReaddir = fs.readdir.bind(fs)
    const { ctx, requests } = fakeContext(() => {
      vi.spyOn(fs, 'readdir').mockImplementation(((p: string) =>
        p.endsWith('sub')
          ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
          : realReaddir(p)) as typeof fs.readdir)
      return true
    })
    const r = await h
      .tool('move_file')
      .execute(
        { source: path.join(sb.root, 'proj'), destination: path.join(sb.root, 'moved') },
        ctx,
      )
    vi.restoreAllMocks()
    expect(requests).toHaveLength(1)
    expect(r).toMatchObject({ isError: true, content: /Could not check everything/ })
    expect(await exists(path.join(sb.root, 'proj', 'sub', 'a.txt'))).toBe(true)
    expect(await exists(path.join(sb.root, 'moved'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'refuses an 8.3 short-name alias of a protected file (Windows only: needs NTFS short names)',
    async (ctx) => {
      const secret = path.join(sb.root, '.env.production')
      await put(secret, 'SECRET=1')
      await put(path.join(sb.root, 'plain.txt'), 'p')
      const alias = windowsShortPath(secret)
      if (alias === null) {
        ctx.skip()
        return
      }
      const { ctx: call, requests } = fakeContext(true)
      for (const input of [
        { source: alias, destination: path.join(sb.root, 'visible.txt') },
        { source: path.join(sb.root, 'plain.txt'), destination: alias, overwrite: true },
      ]) {
        expect(await h.tool('move_file').execute(input, call), JSON.stringify(input)).toMatchObject(
          {
            isError: true,
            content: /blocked/,
          },
        )
      }
      expect(await h.tool('delete_path').execute({ path: alias }, call)).toMatchObject({
        isError: true,
        content: /blocked/,
      })
      expect(requests).toEqual([])
      expect(h.trashed).toEqual([])
      expect(await fs.readFile(secret, 'utf8')).toBe('SECRET=1')
    },
  )

  it('moves a link itself, not its target', async () => {
    const link = path.join(sb.root, 'out')
    expect(await trySymlink(sb.outside, link, 'dir')).toBe(true)
    await put(path.join(sb.outside, 'keep.txt'), 'k')
    const r = await h
      .tool('move_file')
      .execute({ source: link, destination: path.join(sb.root, 'renamed') }, fakeContext(true).ctx)
    expect(r.isError).toBeUndefined()
    expect((await fs.lstat(path.join(sb.root, 'renamed'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(path.join(sb.outside, 'keep.txt'), 'utf8')).toBe('k')
  })
})

describe('delete_path', () => {
  it('sends a file to the trash after approval, never deleting it itself', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'A')
    const { ctx, requests } = fakeContext(true)
    const r = await h.tool('delete_path').execute({ path: file }, ctx)
    expect(r).toEqual({ content: `Moved ${file} to the Recycle Bin.` })
    expect(h.trashed).toEqual([file])
    // The fake trash does nothing, so the file is still there: no hard delete happened.
    expect(await exists(file)).toBe(true)
    expect(requests[0]).toMatchObject({
      kind: 'delete',
      summary: `Move file ${file} to the Recycle Bin`,
    })
  })

  it('does nothing when declined', async () => {
    const file = path.join(sb.root, 'a.txt')
    await put(file, 'A')
    const r = await h.tool('delete_path').execute({ path: file }, fakeContext(false).ctx)
    expect(r).toMatchObject({ isError: true, content: /declined/ })
    expect(h.trashed).toEqual([])
  })

  it('refuses grant roots, blocked paths, outside paths and folders with protected files', async () => {
    await put(path.join(sb.root, 'proj', 'secrets', 'api.key'), 'k')
    await put(path.join(sb.root, '.env'), 'S')
    await put(path.join(sb.outside, 'x'), 'x')
    const { ctx, requests } = fakeContext(true)
    for (const target of [
      sb.root,
      path.join(sb.root, '.env'),
      path.join(sb.outside, 'x'),
      path.join(sb.root, 'proj'),
    ]) {
      expect(await h.tool('delete_path').execute({ path: target }, ctx), target).toMatchObject({
        isError: true,
      })
    }
    expect(requests).toEqual([])
    expect(h.trashed).toEqual([])
  })

  it('refuses to delete a hard-linked file', async () => {
    await put(path.join(sb.outside, 'target.txt'), 't')
    await fs.link(path.join(sb.outside, 'target.txt'), path.join(sb.root, 'alias.txt'))
    const { ctx, requests } = fakeContext(true)
    expect(
      await h.tool('delete_path').execute({ path: path.join(sb.root, 'alias.txt') }, ctx),
    ).toMatchObject({ isError: true, content: /hard links/ })
    expect(requests).toEqual([])
    expect(h.trashed).toEqual([])
  })

  it('fails closed if the folder cannot be fully checked, before approval', async () => {
    await put(path.join(sb.root, 'proj', 'sub', 'a.txt'), 'a')
    const realReaddir = fs.readdir.bind(fs)
    vi.spyOn(fs, 'readdir').mockImplementation(((p: string) =>
      p.endsWith('sub')
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        : realReaddir(p)) as typeof fs.readdir)
    const { ctx, requests } = fakeContext(true)
    const r = await h.tool('delete_path').execute({ path: path.join(sb.root, 'proj') }, ctx)
    vi.restoreAllMocks()
    expect(r).toMatchObject({ isError: true, content: /Could not check everything/ })
    expect(requests).toEqual([])
    expect(h.trashed).toEqual([])
  })

  it('refuses folders too large to check', async () => {
    h = toolHarness(sb, { limits: { maxScanEntries: 2 } })
    for (const n of ['a', 'b', 'c']) await put(path.join(sb.root, 'big', n))
    expect(
      await h
        .tool('delete_path')
        .execute({ path: path.join(sb.root, 'big') }, fakeContext(true).ctx),
    ).toMatchObject({ isError: true, content: /too many entries/ })
    expect(h.trashed).toEqual([])
  })

  it('reports trash failures', async () => {
    h = toolHarness(sb, { trash: () => Promise.reject(new Error('no recycle bin')) })
    await put(path.join(sb.root, 'a.txt'))
    expect(
      await h
        .tool('delete_path')
        .execute({ path: path.join(sb.root, 'a.txt') }, fakeContext(true).ctx),
    ).toMatchObject({ isError: true, content: /no recycle bin/ })
    expect(await exists(path.join(sb.root, 'a.txt'))).toBe(true)
  })

  it('deletes a link pointing outside the grant without touching its target', async () => {
    const link = path.join(sb.root, 'out')
    expect(await trySymlink(sb.outside, link, 'dir')).toBe(true)
    const r = await h.tool('delete_path').execute({ path: link }, fakeContext(true).ctx)
    expect(r.isError).toBeUndefined()
    expect(h.trashed).toEqual([link])
  })
})
