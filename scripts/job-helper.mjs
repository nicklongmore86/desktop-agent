// job-run.exe (native/job-run): the build's pins file and the checks shared by
// build-job-helper.mjs, the Vite build (which compiles the digest into the app) and afterPack.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const JOB_RUN_VERSION = '1.0.0.0'
export const repoRoot = fileURLToPath(new URL('..', import.meta.url))
/** The built launcher; electron-builder copies build/helpers to resources/helpers. */
export const helperFile = join(repoRoot, 'build', 'helpers', 'job-run.exe')
/** Written next to (not inside) build/helpers, so it is not packaged. */
export const pinsFile = join(repoRoot, 'build', 'job-helper-pins.json')
export const PINNED_PATH = 'helpers/job-run.exe'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The pinned digest of this build's launcher, or null if it was not built. */
export function readPin() {
  if (!existsSync(pinsFile)) return null
  const hash = JSON.parse(readFileSync(pinsFile, 'utf8'))[PINNED_PATH]?.sha256
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) throw new Error(`Invalid pin in ${pinsFile}`)
  return hash
}

const PE_FLAGS = {
  HIGH_ENTROPY_VA: 0x0020,
  DYNAMIC_BASE: 0x0040,
  NX_COMPAT: 0x0100,
  GUARD_CF: 0x4000,
}

/** Fails unless `bytes` is an x64 console PE with ASLR, DEP and Control Flow Guard. */
export function checkHardening(bytes) {
  const pe = bytes.readUInt32LE(0x3c)
  if (bytes.toString('latin1', 0, 2) !== 'MZ' || bytes.readUInt32LE(pe) !== 0x4550)
    throw new Error('job-run.exe is not a PE file')
  if (bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('job-run.exe is not x64')
  const optional = pe + 24
  if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error('job-run.exe is not PE32+')
  if (bytes.readUInt16LE(optional + 68) !== 3) throw new Error('job-run.exe is not a console app')
  const flags = bytes.readUInt16LE(optional + 70)
  const missing = Object.entries(PE_FLAGS).filter(([, bit]) => (flags & bit) === 0)
  if (missing.length)
    throw new Error(`job-run.exe lacks ${missing.map(([name]) => name).join(', ')}`)
}

/** Main entries built only for the real-Electron tests (electron.vite.config.ts). */
const TEST_ENTRIES = ['tools.js', 'documents.js']
/** Written into out/main by the main build: its chunks and their imports, from Rollup. */
export const BUILD_MANIFEST = '.build-manifest.json'
/** The string the main build compiles in for job-launcher.ts's JOB_RUN_SHA256. */
export const pinMarker = (pin) => (pin ? `job-run.exe-sha256:${pin}` : null)
const MARKER = /job-run\.exe-sha256:([0-9a-f]{64})/g
// A call of the global require() or of import() with anything but a string literal: a load no
// manifest can list. Not a method of that name (`x.require(id)`, or its definition).
const COMPUTED_LOAD =
  /(?<![\w$.])(?:require|import)\s*\(\s*(?!(["'`])[^"'`$\\\n]*\1\s*\))(?![^()\n]*\)\s*\{)/

/** Every file under `dir`, recursively. */
async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
}

/**
 * The job-run.exe pin compiled into the production main bundle. The bundle is the graph
 * Rollup recorded in out/main/.build-manifest.json from the main entry (package.json `main`)
 * through its static and dynamic imports; the files themselves are only searched for the pin.
 * Fails unless every chunk in that graph is inside out/main, none is a test-only entry or
 * loads a computed path, and the pin's marker appears exactly once in the graph and nowhere
 * else under out/main.
 */
export async function bundledPin(root = repoRoot) {
  const mainDir = resolve(root, 'out', 'main')
  const realMain = existsSync(mainDir) ? realpathSync(mainDir) : mainDir
  // Inside out/main by path and, through any symlinks, on disk.
  const inMain = (file) =>
    [
      [mainDir, file],
      [realMain, existsSync(file) ? realpathSync(file) : file],
    ].every(([dir, f]) => {
      const rel = relative(dir, f)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  const { main } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const entry = resolve(root, main ?? '')
  if (typeof main !== 'string' || !existsSync(entry) || !inMain(entry))
    throw new Error(`package.json main (${main}) is not a bundle in out/main`)
  const manifestFile = join(mainDir, BUILD_MANIFEST)
  if (!existsSync(manifestFile))
    throw new Error(`The main build wrote no ${BUILD_MANIFEST}: rebuild with \`pnpm build\``)
  const { chunks } = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (typeof chunks !== 'object' || chunks === null)
    throw new Error(`${manifestFile} lists no chunks`)
  const chunkOf = (file) => relative(mainDir, file).split(sep).join('/')
  const start = chunkOf(entry)
  if (!Object.hasOwn(chunks, start) || chunks[start]?.isEntry !== true)
    throw new Error(`${BUILD_MANIFEST} has no entry ${start}`)
  const graph = new Map()
  const queue = [start]
  while (queue.length) {
    const file = resolve(mainDir, queue.pop())
    const name = chunkOf(file)
    if (graph.has(file)) continue
    if (TEST_ENTRIES.includes(name))
      throw new Error(`The production main bundle loads a test-only entry: ${name}`)
    const chunk = Object.hasOwn(chunks, name) ? chunks[name] : undefined
    if (!chunk || !name.endsWith('.js') || !existsSync(file) || !inMain(file))
      throw new Error(`Cannot resolve chunk ${name} inside out/main`)
    const code = await readFile(file, 'utf8')
    const load = code.match(COMPUTED_LOAD)
    if (load)
      throw new Error(`${name} loads a computed path the manifest cannot list: ${load[0]}...`)
    graph.set(file, code)
    for (const edge of [chunk.imports ?? [], chunk.dynamicImports ?? []].flat()) {
      if (typeof edge !== 'string') throw new Error(`${BUILD_MANIFEST}: bad import of ${name}`)
      queue.push(edge)
    }
  }
  const pins = [...graph.values()].flatMap((code) => [...code.matchAll(MARKER)].map((m) => m[1]))
  if (pins.length === 0)
    throw new Error('The app was built without the job-run.exe pin: rebuild after build:helpers')
  if (pins.length !== 1)
    throw new Error(
      `The production main bundle has the job-run.exe pin ${pins.length} times: ${pins.toSorted().join(', ')}`,
    )
  for (const file of await filesUnder(mainDir)) {
    if (graph.has(file)) continue
    if ((await readFile(file, 'latin1')).search(MARKER) !== -1)
      throw new Error(`A job-run.exe pin outside the production main bundle: ${file}`)
  }
  return pins[0]
}

/**
 * afterPack: resources/helpers/job-run.exe is present, hardened, matches this build's pin,
 * and the production main bundle carries that same pin.
 */
export async function verifyHelpers(resources) {
  const pin = readPin()
  if (!pin) throw new Error('job-run.exe was not built: run `pnpm build:helpers` before packaging')
  const bytes = await readFile(join(resources, ...PINNED_PATH.split('/')))
  if (sha256(bytes) !== pin) throw new Error('Packaged job-run.exe does not match its pin')
  checkHardening(bytes)
  if ((await bundledPin()) !== sha256(bytes))
    throw new Error('The app was built with another job-run.exe pin: rebuild after build:helpers')
  console.log(`Verified packaged job-run.exe ${JOB_RUN_VERSION} (sha256 ${pin}).`)
}
