import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledPin } from './job-helper.mjs'

const PIN = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
// As Rollup compiles job-launcher.ts with __JOB_RUN_SHA256__ defined.
const launcher = (pin) =>
  `"use strict";\nconst JOB_RUN_SHA256 = /^[0-9a-f]{64}$/.test("${pin}") ? "${pin}" : null;\n`

describe('bundledPin', () => {
  let root

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'job-helper-'))
    await write('package.json', JSON.stringify({ main: './out/main/index.js' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  async function write(file, text) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), text)
  }
  // The production entry loading a shared chunk, as the multi-entry main build does.
  const entry = (chunk = './chunks/index-x.js') =>
    write(
      'out/main/index.js',
      `"use strict";\nconst fs = require("node:fs");\nconst index = require("${chunk}");\n`,
    )

  it('finds the pin in a chunk the main entry loads', async () => {
    await entry()
    await write('out/main/chunks/index-x.js', `const reply = require("./reply-y.js");\n`)
    await write('out/main/chunks/reply-y.js', launcher(PIN))
    await expect(bundledPin(root)).resolves.toBe(PIN)
  })

  it('ignores a pin only in files the main entry does not load', async () => {
    await entry()
    await write('out/main/chunks/index-x.js', launcher('null'))
    await write('out/main/tools.js', launcher(PIN))
    await write('out/main/chunks/decoy-z.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/without the job-run.exe pin/)
  })

  it('fails on two different pins', async () => {
    await entry()
    await write('out/main/chunks/index-x.js', `require("./a.js");\nrequire("./b.js");\n`)
    await write('out/main/chunks/a.js', launcher(PIN))
    await write('out/main/chunks/b.js', launcher(OTHER))
    await expect(bundledPin(root)).rejects.toThrow(/defines the job-run.exe pin 2 times/)
  })

  it('fails on one definition holding two digests', async () => {
    await entry()
    await write(
      'out/main/chunks/index-x.js',
      `const JOB_RUN_SHA256 = /^[0-9a-f]{64}$/.test("${PIN}") ? "${OTHER}" : null;\n`,
    )
    await expect(bundledPin(root)).rejects.toThrow(/pin 1 times, with a+, b+/)
  })

  it('fails when the pin is missing', async () => {
    await entry()
    await write('out/main/chunks/index-x.js', '"use strict";\n')
    await expect(bundledPin(root)).rejects.toThrow(/without the job-run.exe pin/)
  })

  it('fails on a local import it cannot resolve', async () => {
    await entry('./chunks/missing.js')
    await expect(bundledPin(root)).rejects.toThrow(/Cannot resolve \.\/chunks\/missing\.js/)
  })

  it('fails on an import outside out/main', async () => {
    await entry('../outside.js')
    await write('out/outside.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/Cannot resolve \.\.\/outside\.js/)
  })

  // Creating symlinks needs Developer Mode or elevation on Windows.
  it.skipIf(process.platform === 'win32')(
    'fails on a chunk symlinked from outside out/main',
    async () => {
      await entry()
      await write('elsewhere.js', launcher(PIN))
      await mkdir(join(root, 'out', 'main', 'chunks'), { recursive: true })
      await symlink(join(root, 'elsewhere.js'), join(root, 'out', 'main', 'chunks', 'index-x.js'))
      await expect(bundledPin(root)).rejects.toThrow(/Cannot resolve/)
    },
  )

  it('fails when the main entry loads a test-only entry', async () => {
    await entry('./tools.js')
    await write('out/main/tools.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/test-only entry/)
  })

  it('fails when package.json main is not in out/main', async () => {
    await write('package.json', JSON.stringify({ main: './index.js' }))
    await write('index.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/package.json main/)
  })
})
