import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILD_MANIFEST, bundledPin, pinMarker } from './job-helper.mjs'

const PIN = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
// As Rollup compiles job-launcher.ts with __JOB_RUN_PIN__ defined; the name is irrelevant.
const launcher = (pin, name = 'JOB_RUN_SHA256') =>
  `"use strict";\nconst ${name} = /^job-run\\.exe-sha256:([0-9a-f]{64})$/.exec(${JSON.stringify(pinMarker(pin))})?.[1] || null;\n`

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
  // out/main/.build-manifest.json as the main build writes it: { file: [imports, dynamic] }.
  const manifest = (chunks) =>
    write(
      `out/main/${BUILD_MANIFEST}`,
      JSON.stringify({
        version: 1,
        chunks: Object.fromEntries(
          Object.entries(chunks).map(([file, [imports = [], dynamicImports = []]]) => [
            file,
            { isEntry: !file.startsWith('chunks/'), imports, dynamicImports },
          ]),
        ),
      }),
    )
  // The production entry loading a shared chunk, as the multi-entry main build does.
  const entry = () =>
    write(
      'out/main/index.js',
      `"use strict";\nconst fs = require("node:fs");\nconst index = require("./chunks/index-x.js");\n`,
    )

  it('finds the pin in a chunk the main entry loads', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write('out/main/chunks/index-x.js', launcher(PIN))
    await expect(bundledPin(root)).resolves.toBe(PIN)
  })

  it('includes a chunk the manifest lists as a dynamic import', async () => {
    await entry()
    await manifest({
      'index.js': [['chunks/index-x.js']],
      'chunks/index-x.js': [[], ['chunks/lazy-y.js']],
      'chunks/lazy-y.js': [],
    })
    await write(
      'out/main/chunks/index-x.js',
      `const lazy = () => Promise.resolve().then(() => require("./lazy-y.js"));\n`,
    )
    await write('out/main/chunks/lazy-y.js', launcher(PIN))
    await expect(bundledPin(root)).resolves.toBe(PIN)
  })

  it('finds the pin by its marker, whatever the constant is called', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write('out/main/chunks/index-x.js', launcher(PIN, 'JOB_RUN_SHA256$1'))
    await expect(bundledPin(root)).resolves.toBe(PIN)
  })

  it('ignores an import that is only in a comment or string', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write(
      'out/main/chunks/index-x.js',
      `// require("./decoy-z.js")\nconst s = 'import "./decoy-z.js"';\n${launcher(null)}`,
    )
    await write('out/main/chunks/decoy-z.js', launcher(PIN))
    // The decoy is not in the manifest graph, so its pin is not the bundle's.
    await expect(bundledPin(root)).rejects.toThrow(/pin is outside the production main bundle/)
  })

  it.each([
    ['a file the main entry does not load', 'chunks/decoy-z.js', launcher(PIN)],
    ['a test-only entry the manifest omits', 'tools.js', launcher(PIN)],
    ['a non-.js file', 'chunks/decoy.txt', `pin ${pinMarker(OTHER)}\n`],
    ['the build manifest', 'x/.build-manifest.json', JSON.stringify({ pin: pinMarker(PIN) })],
  ])('fails on a decoy marker in %s', async (_, file, text) => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write('out/main/chunks/index-x.js', launcher(PIN))
    await write(`out/main/${file}`, text)
    await expect(bundledPin(root)).rejects.toThrow(/pin marker 2 times/)
  })

  // A chunk loaded by a computed path is in no manifest, but its marker still counts.
  it('fails on a decoy marker in a chunk reachable only by a computed load', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write(
      'out/main/chunks/index-x.js',
      `const load = (n) => globalThis.require("./" + n);\nload("decoy-z.js");\n${launcher(PIN)}`,
    )
    await write('out/main/chunks/decoy-z.js', launcher(OTHER))
    await expect(bundledPin(root)).rejects.toThrow(/pin marker 2 times/)
  })

  it('fails when the only marker is in a file the main entry does not load', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write('out/main/chunks/index-x.js', launcher(null))
    await write('out/main/chunks/decoy-z.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/pin is outside the production main bundle/)
  })

  it('fails when the only marker is in a computed-load-only chunk', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write(
      'out/main/chunks/index-x.js',
      `const m = module.require("./" + "decoy-z.js");\n${launcher(null)}`,
    )
    await write('out/main/chunks/decoy-z.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/pin is outside the production main bundle/)
  })

  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['upper case', 'A'.repeat(64)],
  ])('fails on a marker with an invalid digest: %s', async (_, digest) => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write('out/main/chunks/index-x.js', `const p = "job-run.exe-sha256:${digest}";\n`)
    await expect(bundledPin(root)).rejects.toThrow(/invalid job-run.exe pin/)
  })

  it('fails on a second marker in the bundle', async () => {
    await entry()
    await manifest({
      'index.js': [['chunks/index-x.js', 'chunks/b.js']],
      'chunks/index-x.js': [],
      'chunks/b.js': [],
    })
    await write('out/main/chunks/index-x.js', launcher(PIN))
    await write('out/main/chunks/b.js', launcher(OTHER))
    await expect(bundledPin(root)).rejects.toThrow(/pin marker 2 times/)
  })

  it('fails on the same marker twice', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write(
      'out/main/chunks/index-x.js',
      launcher(PIN) + `const again = "${pinMarker(PIN)}";\n`,
    )
    await expect(bundledPin(root)).rejects.toThrow(/pin marker 2 times/)
  })

  it('fails when the pin is missing', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
    await write('out/main/chunks/index-x.js', launcher(null))
    await expect(bundledPin(root)).rejects.toThrow(/without the job-run.exe pin/)
  })

  it('fails when the manifest is missing', async () => {
    await entry()
    await write('out/main/chunks/index-x.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/wrote no \.build-manifest\.json/)
  })

  it('fails when the manifest has no such entry', async () => {
    await entry()
    await manifest({ 'chunks/index-x.js': [] })
    await write('out/main/chunks/index-x.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/has no entry index\.js/)
  })

  it('fails on a listed chunk that is missing', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/missing.js']], 'chunks/missing.js': [] })
    await expect(bundledPin(root)).rejects.toThrow(/Cannot resolve chunk chunks\/missing\.js/)
  })

  it('fails on a listed chunk the manifest does not describe', async () => {
    await entry()
    await manifest({ 'index.js': [['chunks/index-x.js']] })
    await write('out/main/chunks/index-x.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/Cannot resolve chunk chunks\/index-x\.js/)
  })

  it('fails on a listed chunk outside out/main', async () => {
    await entry()
    await manifest({ 'index.js': [['../outside.js']], '../outside.js': [] })
    await write('out/outside.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/Cannot resolve chunk \.\.\/outside\.js/)
  })

  // Creating symlinks needs Developer Mode or elevation on Windows.
  it.skipIf(process.platform === 'win32')(
    'fails on a chunk symlinked from outside out/main',
    async () => {
      await entry()
      await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
      await write('elsewhere.js', launcher(PIN))
      await mkdir(join(root, 'out', 'main', 'chunks'), { recursive: true })
      await symlink(join(root, 'elsewhere.js'), join(root, 'out', 'main', 'chunks', 'index-x.js'))
      await expect(bundledPin(root)).rejects.toThrow(/Not a file or folder in out\/main/)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'fails on any symlink under out/main, even one nothing loads',
    async () => {
      await entry()
      await manifest({ 'index.js': [['chunks/index-x.js']], 'chunks/index-x.js': [] })
      await write('out/main/chunks/index-x.js', launcher(PIN))
      await mkdir(join(root, 'elsewhere'))
      await symlink(join(root, 'elsewhere'), join(root, 'out', 'main', 'linked'))
      await expect(bundledPin(root)).rejects.toThrow(/Not a file or folder in out\/main/)
    },
  )

  it.skipIf(process.platform === 'win32')('fails when out/main is a symlink', async () => {
    await write('real-main/index.js', launcher(PIN))
    await mkdir(join(root, 'out'))
    await symlink(join(root, 'real-main'), join(root, 'out', 'main'))
    await expect(bundledPin(root)).rejects.toThrow(/is a symlink/)
  })

  it('fails when the main entry loads a test-only entry', async () => {
    await entry()
    await manifest({ 'index.js': [[], ['chunks/../tools.js']], 'tools.js': [] })
    await write('out/main/tools.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/test-only entry: tools\.js/)
  })

  it('fails when package.json main is not in out/main', async () => {
    await write('package.json', JSON.stringify({ main: './index.js' }))
    await write('index.js', launcher(PIN))
    await expect(bundledPin(root)).rejects.toThrow(/package.json main/)
  })
})
