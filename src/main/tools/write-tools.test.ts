import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exists,
  fakeContext,
  makeSandbox,
  put,
  trySymlink,
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

  it('caps the content size and the preview size', async () => {
    h = toolHarness(sb, { limits: { maxWriteBytes: 10, maxDiffBytes: 40 } })
    const { ctx, requests } = fakeContext(false)
    expect(
      await h
        .tool('write_file')
        .execute({ path: path.join(sb.root, 'big'), content: 'x'.repeat(11) }, ctx),
    ).toMatchObject({ isError: true, content: /write limit/ })
    await h
      .tool('write_file')
      .execute({ path: path.join(sb.root, 'ok'), content: 'a\nb\nc\nd\ne\n' }, ctx)
    expect(requests[0]?.detail).toMatch(/diff truncated/)
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
